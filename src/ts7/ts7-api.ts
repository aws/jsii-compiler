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
 * alias. 
 * ---------------------------------------------------------------------------
 */
import * as nodeModule from 'node:module';
import * as path from 'node:path';
import * as semver from 'semver';

/** Environment variable pointing at the directory of a `typescript` (>= 7.1) package install. */
export const TS7_TYPESCRIPT_ENV = 'JSII_TS7_TYPESCRIPT';

/** Minimum TypeScript version that ships the `typescript/sync` programmatic API. */
export const TS7_MIN_VERSION = '7.1.0-0';

/** One-line install hint, used in error messages. */
export const TS7_INSTALL_HINT = 'npm i -D typescript@beta';

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
 *  2. the `typescript` package, resolved from the project being compiled and
 *     then from this compiler's own install, when it is >= 7.1
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
  const candidates = ['typescript'];
  const seen: string[] = [];
  for (const candidate of candidates) {
    for (const base of bases) {
      let dir: string;
      try {
        dir = path.dirname(nodeModule.createRequire(base).resolve(`${candidate}/package.json`));
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
    'jsii needs the TypeScript 7.1+ programmatic API (`typescript/sync`), which was not found. ' +
      `Install it with \`${TS7_INSTALL_HINT}\`, ` +
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

/**
 * `createRequire` from Node's own `Module`, even when a test runner (jest) hands
 * out a sandboxed subclass whose loader cannot load ES modules: the real class is
 * the deepest one on the prototype chain that still provides `createRequire`.
 */
function nodeCreateRequire(filename: string): NodeJS.Require {
  let real: any = (nodeModule as any).Module ?? nodeModule;
  while (typeof Object.getPrototypeOf(real)?.createRequire === 'function') {
    real = Object.getPrototypeOf(real);
  }
  return real.createRequire(filename);
}

let cached: Ts7Api | undefined;

/**
 * Load the TypeScript 7 `sync` API and the AST enums. Throws a helpful error
 * (with the install one-liner) when no suitable package exists.
 */
export function loadTs7Api(projectRoot: string): Ts7Api {
  if (cached) {
    return cached;
  }
  const packageDir = resolveTypeScript7PackageDir(projectRoot);
  const version = readPackageVersion(packageDir) ?? '<unknown>';

  // The package is ESM; Node >= 22.12 can `require()` ES modules synchronously,
  // which keeps the compiler's public API (e.g. `compileJsiiForTest`) synchronous.
  // Entry points are loaded by path so the package's own `#enums/*` imports resolve
  // regardless of how (or under which name) the package was installed.
  const apiPath = path.join(packageDir, 'dist', 'api', 'sync', 'api.js');
  const astPath = path.join(packageDir, 'dist', 'ast', 'index.js');
  const nativeRequire = nodeCreateRequire(__filename);
  let apiModule: any;
  let astModule: any;
  try {
    apiModule = nativeRequire(apiPath);
    astModule = nativeRequire(astPath);
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
