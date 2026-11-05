/*
 * ---------------------------------------------------------------------------
 * Experimental TypeScript 7 (tsgo) backend for jsii.
 *
 * This module locates and loads the TypeScript 7 programmatic API that the
 * backend runs against: the `typescript/sync` entry point shipped with the
 * `typescript` package since 7.1 (an out-of-process client talking to the
 * native `tsc` binary bundled in the package's platform-specific dependency).
 *
 * The API is loaded dynamically (not a static `import`) because it lives in a
 * SECOND copy of the `typescript` package: the compiler itself depends on the
 * current TypeScript release line, so the 7.x package is installed under an
 * alias. The default backend never touches this file.
 * ---------------------------------------------------------------------------
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as semver from 'semver';

/** Environment variable pointing at the directory of a `typescript` (>= 7.1) package install. */
export const TS7_TYPESCRIPT_ENV = 'JSII_TS7_TYPESCRIPT';

/** The alias under which the 7.x `typescript` package is expected to be installed. */
export const TS7_ALIAS_PACKAGE = 'typescript7';

/** Minimum TypeScript version that ships the `typescript/sync` programmatic API. */
export const TS7_MIN_VERSION = '7.1.0-0';

/** One-line install hint, used in error messages. */
export const TS7_INSTALL_HINT = `npm i -D ${TS7_ALIAS_PACKAGE}@npm:typescript@beta`;

/**
 * A very small, intentionally loose view of the pieces of the TypeScript 7 API
 * surface that the ts7 backend consumes. This experimental phase favours a
 * working `.jsii` over precise typings (see the file header of `assembler.ts`).
 */
export interface Ts7Api {
  /* eslint-disable @typescript-eslint/naming-convention */
  readonly API: any;
  readonly SymbolFlags: any;
  readonly TypeFlags: any;
  readonly SyntaxKind: any;
  /* eslint-enable @typescript-eslint/naming-convention */
  /** Combines request generators so `api.batch(all(...))` issues them in one round-trip. */
  readonly all: (...generators: any[]) => any;
  /** Directory of the `typescript` package the API was loaded from. */
  readonly packageDir: string;
  /** Version of that package. */
  readonly version: string;
}

/**
 * Resolve the directory of a `typescript` package that is new enough to expose
 * the `typescript/sync` API.
 *
 * Resolution order:
 *  1. `JSII_TS7_TYPESCRIPT` (explicit package directory)
 *  2. the `typescript7` alias package, resolved from the project being compiled
 *     and then from this compiler's own install
 *  3. the project's regular `typescript` package, when it is >= 7.1
 *
 * Exported for unit tests.
 */
export function resolveTypeScript7PackageDir(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[TS7_TYPESCRIPT_ENV];
  if (explicit) {
    const dir = path.resolve(explicit);
    const version = readPackageVersion(dir);
    if (!isNewEnough(version)) {
      throw new Error(
        `${TS7_TYPESCRIPT_ENV} points at ${dir}, which holds typescript ${version ?? '<unknown>'}; ` +
          `the ts7 backend needs typescript >= 7.1 (${TS7_MIN_VERSION}).`,
      );
    }
    return dir;
  }

  const bases = [path.join(projectRoot, 'package.json'), __filename];
  const candidates = [TS7_ALIAS_PACKAGE, 'typescript'];
  const seen: string[] = [];
  for (const candidate of candidates) {
    for (const base of bases) {
      let dir: string;
      try {
        dir = path.dirname(createRequire(base).resolve(`${candidate}/package.json`));
      } catch {
        continue;
      }
      const version = readPackageVersion(dir);
      if (isNewEnough(version)) {
        return dir;
      }
      seen.push(`${candidate}@${version ?? '<unknown>'} (${dir})`);
    }
  }

  throw new Error(
    'The experimental ts7 backend needs the TypeScript 7.1+ programmatic API (`typescript/sync`), which was not found. ' +
      `Install it alongside your existing TypeScript with \`${TS7_INSTALL_HINT}\`, ` +
      `or set ${TS7_TYPESCRIPT_ENV} to the directory of a typescript >= 7.1 package.` +
      (seen.length ? ` Found but too old: ${seen.join(', ')}.` : ''),
  );
}

function readPackageVersion(dir: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require(path.join(dir, 'package.json'));
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function isNewEnough(version: string | undefined): boolean {
  return version != null && semver.valid(version) != null && semver.gte(version, TS7_MIN_VERSION);
}

let cached: Ts7Api | undefined;

/**
 * Dynamically load the TypeScript 7 `sync` API and the AST enums. Throws a
 * helpful error (with the install one-liner) when no suitable package exists.
 */
export async function loadTs7Api(projectRoot: string): Promise<Ts7Api> {
  if (cached) {
    return cached;
  }
  const packageDir = resolveTypeScript7PackageDir(projectRoot);
  const version = readPackageVersion(packageDir) ?? '<unknown>';

  // The package is ESM; import its entry points by file URL so the alias name
  // never matters and the package-internal `#enums/*` imports keep resolving.
  const apiUrl = pathToFileURL(path.join(packageDir, 'dist', 'api', 'sync', 'api.js')).href;
  const astUrl = pathToFileURL(path.join(packageDir, 'dist', 'ast', 'index.js')).href;
  let apiModule: any;
  let astModule: any;
  try {
    apiModule = await import(apiUrl);
    astModule = await import(astUrl);
  } catch (err) {
    throw new Error(
      `Failed to load the TypeScript 7 programmatic API from "${packageDir}" (typescript ${version}): ${
        (err as Error).message
      }`,
    );
  }

  cached = {
    API: apiModule.API,
    SymbolFlags: apiModule.SymbolFlags,
    TypeFlags: apiModule.TypeFlags,
    SyntaxKind: astModule.SyntaxKind,
    all: apiModule.all,
    packageDir,
    version,
  };
  return cached;
}
