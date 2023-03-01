import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { main as downlevel } from 'downlevel-dts';
import * as log4js from 'log4js';
import { SemVer } from 'semver';
import * as ts from 'typescript';
import type { PackageJson, ProjectInfo } from './project-info';
import type { Mutable } from './utils';

const LOG = log4js.getLogger('jsii/compiler');

const TS_VERSION = new SemVer(`${ts.versionMajorMinor}.0`);

/**
 * Declares what versions of the TypeScript language will be supported by the
 * declarations files (and `typesVersions` entries) produced by this compiler
 * release.
 *
 * This should contain only `major.minor` specifiers, similar to the value of
 * the `ts.versionMajorMinor` property, and must be sorted in ascending version
 * order, as this dictates the order of entries in the `typesVersions` redirects
 * which has a direct impact on resolution (first match wins), and we don't want
 * to have to perform a sort pass on this list.
 */
const DOWNLEVEL_BREAKPOINTS: readonly SemVer[] = ['3.9'].map((ver) => new SemVer(`${ver}.0`));

/**
 * Produces down-leveled declaration files to ensure compatibility with previous
 * compiler releases (macthing TypeScript's `major.minor` versioning scheme).
 * This is necessary in order to ensure a package change compiler release lines
 * does not force all it's consumers to do the same (and vice-versa).
 *
 * @returns the `typesVersions` object that should be recorded in `package.json`
 */
export function emitDownleveledDeclarations({ packageJson, projectRoot, tsc }: ProjectInfo) {
  const rewrites = new Map<`${number}.${number}`, Map<string, string>>();

  for (const breakpoint of DOWNLEVEL_BREAKPOINTS) {
    if (TS_VERSION.compare(breakpoint) <= 0) {
      // This TypeScript release is older or same as the breakpoint, so no need
      // for down-leveling here.
      continue;
    }

    const rewriteSet = new Map<string, string>();
    let needed = false;

    // We'll emit down-leveled declarations in a temporary directory...
    const workdir = mkdtempSync(join(tmpdir(), `downlevel-dts-${breakpoint}-${basename(projectRoot)}-`));
    try {
      downlevel(projectRoot, workdir, breakpoint.version);
      for (const dts of walkDirectory(workdir)) {
        const original = readFileSync(join(projectRoot, dts), 'utf-8');
        const downleveled = readFileSync(join(workdir, dts), 'utf-8');
        needed ||= !equalWithNormalizedLineTerminator(original, downleveled);
        rewriteSet.set(dts, downleveled);
      }

      // If none of the declarations files changed during the down-level, then
      // we don't need to actually write it out & cause a redirect. This would
      // be wasteful. Most codebases won't incur any rewrite at all, since the
      // declarations files only reference "visible" members, and `jsii`
      // actually does not allow most of the unsupported syntaxes to be used
      // anyway.
      if (needed) {
        rewrites.set(`${breakpoint.major}.${breakpoint.minor}`, rewriteSet);
      }
    } finally {
      // Clean up after outselves...
      rmSync(workdir, { force: true, recursive: true });
    }
  }

  let typesVersions: Mutable<PackageJson['typesVersions']>;

  const typesCompat = '.types-compat';
  for (const [version, rewriteSet] of rewrites) {
    const versionSuffix = `ts${version}`;
    const compatDir = join(projectRoot, ...(tsc?.outDir != null ? [tsc?.outDir] : []), typesCompat, versionSuffix);
    if (!existsSync(compatDir)) {
      mkdirSync(compatDir, { recursive: true });
      // Make sure all of this is gitignored, out of courtesy...
      writeFileSync(join(projectRoot, typesCompat, '.gitignore'), '*\n', 'utf-8');
    }

    for (const [dts, downleveled] of rewriteSet) {
      const rewritten = join(compatDir, dts);
      // Make sure the parent directory exists (dts might be nested)
      mkdirSync(dirname(rewritten), { recursive: true });
      // Write the re-written declarations file there...
      writeFileSync(rewritten, downleveled, 'utf-8');
    }

    // Register the type redirect in the typesVersions configuration
    typesVersions ??= {};
    const from = [...(tsc?.outDir != null ? [tsc?.outDir] : []), '*'].join('/');
    const to = [...(tsc?.outDir != null ? [tsc?.outDir] : []), typesCompat, versionSuffix, '*'].join('/');
    typesVersions[`<=${version}`] = { [from]: [to] };
  }

  // Compare JSON stringifications, as the order of keys is important here...
  if (JSON.stringify(packageJson.typesVersions) === JSON.stringify(typesVersions)) {
    // The existing configuration matches the new one. We're done here.
    return;
  }

  LOG.info('The required `typesVersions` configuration has changed. Updating "package.json" accordingly...');

  // Prepare the new contents of `PackageJson`.
  const newPackageJson = Object.entries(packageJson).reduce((obj, [key, value]) => {
    // NB: "as any" below are required becuase we must ignore `readonly` attributes from the source.
    if (key === 'typesVersions') {
      if (typesVersions != null) {
        obj[key] = typesVersions as any;
      }
    } else {
      obj[key] = value as any;
      // If there isn't currently a `typesVersions` entry, but there is a `types` entry,
      // we'll insert `typesVersions` right after `types`.
      if (key === 'types' && typesVersions != null && !('typesVersions' in packageJson)) {
        obj.typesVersions = typesVersions as any;
      }
    }
    return obj;
  }, {} as Mutable<PackageJson>);
  // If there was neither `types` nor `typesVersions` in the original `package.json`, we'll
  // add `typesVersions` at the end of it.
  if (!('typesVersions' in newPackageJson)) {
    newPackageJson.typesVersions = typesVersions as any;
  }

  const packageJsonFile = join(projectRoot, 'package.json');

  // We try "hard" to preserve the existing indent in the `package.json` file when updating it.
  const [, indent] = readFileSync(packageJsonFile, 'utf-8').match(/^(\s*)"/m) ?? [null, 2];

  writeFileSync(packageJsonFile, `${JSON.stringify(newPackageJson, undefined, indent)}\n`, 'utf-8');
}

/**
 * Compares two strings ignoring new line differences. This is necessary because
 * `downlevel-dts` may use a different line-ending convention (at time of
 * writing, it always uses CRLF) than what `jsii` itself emits, but that should
 * not affect the comparison of declarations files.
 *
 * @param left the first string.
 * @param right the second string.
 *
 * @returns `true` if `left` and `right` contain the same text, modulo line
 *          terminator tokens.
 */
function equalWithNormalizedLineTerminator(left: string, right: string): boolean {
  // ECMA262 12.3: https://tc39.es/ecma262/#sec-line-terminators
  const JS_LINE_TERMINATOR_REGEX = /(\n|\r\n?|\u{2028}|\u{2029})/gmu;

  left = left.replace(JS_LINE_TERMINATOR_REGEX, '\n').trim();
  right = right.replace(JS_LINE_TERMINATOR_REGEX, '\n').trim();

  return left === right;
}

/**
 * Recursively traverse the provided directory and yield the relative (to the
 * specified `root`) paths of all the `.d.ts` files found there.
 *
 * @param dir the directory to be walked.
 * @param root the root to which paths should be relative.
 */
function* walkDirectory(dir: string, root: string = dir): Generator<string, void, void> {
  for (const file of readdirSync(dir)) {
    const filePath = join(dir, file);
    if (statSync(filePath).isDirectory()) {
      // This is a directory, recurse down...
      yield* walkDirectory(filePath, root);
    } else if (file.toLowerCase().endsWith('.d.ts')) {
      // This is a declaration file, yield it...
      yield relative(root, filePath);
    }
  }
}
