/*
 * ---------------------------------------------------------------------------
 * Access to the TypeScript 7 programmatic API: loading the `sync` client and
 * the AST enums of the TypeScript package (`#typescript`), and the
 * `CompilerHost` that owns an API session and the project snapshot opened for
 * a tsconfig (program + checker). The assembler reads the raw handles the
 * session returns; nothing here imitates the in-process `ts.Program` /
 * `ts.TypeChecker` of TypeScript 6.
 *
 * The TypeScript package is installed under the `@typescript/native` alias and
 * imported as `#typescript` (see the `imports` field of package.json); the
 * plain `typescript` dev dependency is TypeScript 6, for the development tools
 * that still need the in-process compiler API.
 *
 * The API is loaded with Node's own `require` rather than a static `import`:
 * the package is ESM, and a test runner's module loader (jest) cannot load ES
 * modules through `require()`, while Node >= 22.12 can.
 * ---------------------------------------------------------------------------
 */
import * as nodeModule from 'node:module';
import * as path from 'node:path';
import * as semver from 'semver';

/** Minimum TypeScript version that ships the `sync` programmatic API. */
export const TS7_MIN_VERSION = '7.1.0-0';

/**
 * A very small, intentionally loose view of the pieces of the TypeScript 7 API
 * surface that the compiler consumes. This favours a working `.jsii` over
 * precise typings (see the file header of `assembler.ts`).
 */
export interface TypeScriptApi {
  /* eslint-disable @typescript-eslint/naming-convention */
  readonly API: any;
  readonly SymbolFlags: any;
  readonly TypeFlags: any;
  readonly SyntaxKind: any;
  /* eslint-enable @typescript-eslint/naming-convention */
  /** Combines request generators so `api.batch(all(...))` issues them in one round-trip. */
  readonly all: (...generators: any[]) => any;
  /** Directory of the TypeScript package the API was loaded from. */
  readonly packageDir: string;
  /** Version of that package. */
  readonly version: string;
}

/**
 * The directory of the TypeScript 7 package (`#typescript`), after checking
 * that it is new enough to expose the `sync` API. Exported for unit tests.
 */
export function resolveTypeScript7PackageDir(): string {
  const dir = path.dirname(nodeCreateRequire(__filename).resolve('#typescript/package.json'));
  const version = readPackageVersion(dir);
  if (!isNewEnough(version)) {
    throw new Error(
      `The TypeScript package at ${dir} is typescript ${version ?? '<unknown>'}; ` +
        `jsii needs typescript >= 7.1 (${TS7_MIN_VERSION}) for its programmatic API.`,
    );
  }
  return dir;
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

let cached: TypeScriptApi | undefined;

/**
 * Load the TypeScript 7 `sync` API and the AST enums.
 */
export function loadTypeScriptApi(): TypeScriptApi {
  if (cached) {
    return cached;
  }
  const packageDir = resolveTypeScript7PackageDir();
  const version = readPackageVersion(packageDir) ?? '<unknown>';

  const nativeRequire = nodeCreateRequire(__filename);
  let apiModule: any;
  let astModule: any;
  try {
    apiModule = nativeRequire('#typescript/sync');
    astModule = nativeRequire('#typescript/ast');
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

export interface TypeScriptProject {
  /** The raw `Program` handle. */
  readonly program: any;
  /** The raw `TypeChecker` handle. */
  readonly checker: any;
  /** The owning `API` session (exposes `batch()` for multi-request round-trips). */
  readonly api: any;
  /** The root files of the configuration (`parsedCommandLine.fileNames`). */
  readonly rootFileNames: readonly string[];
}

/**
 * Owns a single API session and the snapshot opened for a project.
 */
export class CompilerHost {
  /**
   * Open an API session against `projectRoot`/`tsconfig.json` and return a host
   * bound to the resulting program + checker.
   */
  public static open(projectRoot: string, tsconfigFileName = 'tsconfig.json'): CompilerHost {
    const ts = loadTypeScriptApi();
    const tsconfigPath = path.join(projectRoot, tsconfigFileName);

    // collectTiming lets us report RPC request counts / bytes for perf work
    // (opt-in via JSII_TS7_TIMING; negligible overhead but off by default).
    const collectTiming = !!process.env.JSII_TS7_TIMING;
    const api = new ts.API({ cwd: projectRoot, collectTiming });
    const snapshot = api.createSnapshot({ openProjects: [tsconfigPath] });

    return new CompilerHost(ts, api, snapshot, tsconfigPath);
  }

  private constructor(
    public readonly ts: TypeScriptApi,
    private readonly api: any,
    private readonly snapshot: any,
    public readonly tsconfigPath: string,
  ) {}

  /** RPC timing info (requestCount/bytes) when JSII_TS7_TIMING is enabled. */
  public getTimingInfo(): any {
    try {
      return this.api.getTimingInfo();
    } catch {
      return undefined;
    }
  }

  /** The program + checker for the opened project. */
  public getProject(): TypeScriptProject {
    const project = this.snapshot.getConfiguredProject(this.tsconfigPath);
    if (!project) {
      throw new Error(`TypeScript project not found for ${this.tsconfigPath}`);
    }
    return {
      program: project.program,
      checker: project.checker,
      api: this.api,
      rootFileNames: project.parsedCommandLine.fileNames,
    };
  }

  /** Dispose the snapshot and close the API session / native process. */
  public close(): void {
    // Tolerate a channel that is already gone (e.g. the server process exited):
    // dispose/close can throw EPIPE, which must not mask the real result.
    try {
      this.snapshot.dispose();
    } catch {
      /* ignore */
    }
    try {
      this.api.close();
    } catch {
      /* ignore */
    }
  }
}
