/*
 * ---------------------------------------------------------------------------
 * Experimental TypeScript 7 (tsgo) backend for jsii.
 *
 * This module locates and loads the patched `@typescript/native-preview` client
 * (the out-of-process API to the Go compiler, "tsgo") that the ts7 backend runs
 * against. The toolchain is provisioned by `scripts/ts7-setup.sh` into `.ts7/`
 * (see that script for the S3-cached build of the patched typescript-go fork).
 *
 * The client is loaded dynamically (not a static `import`) because it is an
 * optional, out-of-tree dependency that only exists when the experimental
 * backend is enabled. The strada (default) backend never touches this file.
 * ---------------------------------------------------------------------------
 */
import * as path from 'node:path';

/**
 * A very small, intentionally loose view of the pieces of the native-preview
 * API surface that the ts7 assembler consumes. This experimental phase favours a working `.jsii`
 * over precise typings (see the file header of `assembler.ts`).
 */
export interface NativePreview {
  /* eslint-disable @typescript-eslint/naming-convention */
  readonly API: any;
  readonly SymbolFlags: any;
  readonly TypeFlags: any;
  readonly SyntaxKind: any;
  /* eslint-enable @typescript-eslint/naming-convention */
  /** Absolute path to the patched tsgo binary. */
  readonly tsgoPath: string;
}

/**
 * Resolve the directory that holds the provisioned toolchain.
 *
 * Resolution order:
 *  1. `JSII_TS7_DIR` environment variable (explicit override)
 *  2. `<repoRoot>/.ts7` (the location `scripts/ts7-setup.sh` writes to)
 */
function resolveToolchainDir(): string {
  if (process.env.JSII_TS7_DIR) {
    return path.resolve(process.env.JSII_TS7_DIR);
  }
  // this file lives at <root>/lib/ts7/native-preview.js (or src/ts7 in ts-node)
  return path.resolve(__dirname, '..', '..', '.ts7');
}

let cached: NativePreview | undefined;

/**
 * Dynamically load the patched native-preview client and the tsgo binary path.
 * Throws a helpful error pointing at the setup script when the toolchain is
 * missing.
 */
export async function loadNativePreview(): Promise<NativePreview> {
  if (cached) {
    return cached;
  }

  const toolchainDir = resolveToolchainDir();
  const npDir = process.env.JSII_TS7_NATIVE_PREVIEW ?? path.join(toolchainDir, 'native-preview');
  const tsgoPath = process.env.TSGO_PATH ?? path.join(toolchainDir, 'tsgo');

  let apiModule: any;
  let astModule: any;
  try {
    apiModule = await import(path.join(npDir, 'dist/api/sync/api.js'));
    astModule = await import(path.join(npDir, 'dist/ast/index.js'));
  } catch (err) {
    throw new Error(
      `Failed to load the experimental TypeScript 7 toolchain from "${npDir}". ` +
        `Provision it with \`scripts/ts7-setup.sh\` (or set JSII_TS7_DIR / JSII_TS7_NATIVE_PREVIEW). ` +
        `Underlying error: ${(err as Error).message}`,
    );
  }

  cached = {
    API: apiModule.API,
    SymbolFlags: apiModule.SymbolFlags,
    TypeFlags: apiModule.TypeFlags,
    SyntaxKind: astModule.SyntaxKind,
    tsgoPath,
  };
  return cached;
}
