/*
 * ---------------------------------------------------------------------------
 * Experimental TypeScript 7 (tsgo) backend for jsii.
 *
 * Public entry point for the ts7 backend, enabled with JSII_COMPILER_BACKEND=ts7.
 * Wires the Ts7Host (API session) -> TypeScript diagnostics check ->
 * Ts7Assembler (TS7-native .jsii generation) -> assembly write (reusing
 * @jsii/spec's writeAssembly for format parity, including the compressed
 * file-redirect form) -> whole-project emit + jsii rtti injection.
 *
 * jsii's own JSII_xxxx diagnostics are not produced on this path (see the
 * ts7/assembler.ts header); TypeScript compilation errors ARE surfaced and
 * fail the build, like the default backend.
 * ---------------------------------------------------------------------------
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as spec from '@jsii/spec';
import { writeAssembly } from '@jsii/spec';
import * as log4js from 'log4js';
import * as ts from 'typescript';

import * as literate from '../literate';
import type { ProjectInfo } from '../project-info';
import { Ts7Assembler } from './assembler';
import { runTs7EmitPipeline } from './ts7-emit';
import { Ts7Host } from './ts7-host';

export { TS7_BACKEND_ENV, isTs7BackendEnabled } from './env';

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const sortJson = require('sort-json');

const LOG = log4js.getLogger('jsii/ts7');

export interface Ts7EmitOptions {
  readonly projectRoot: string;
  readonly projectInfo: ProjectInfo;
  readonly stripDeprecated?: boolean;
  readonly stripDeprecatedAllowListFile?: string;
  readonly compressAssembly?: boolean;
}

export interface Ts7EmitResult {
  readonly assembly?: spec.Assembly;
  readonly typeCount: number;
  readonly emittedFiles: string[];
  readonly emitSkipped: boolean;
  readonly diagnostics: readonly ts.Diagnostic[];
}

/**
 * Derive the entrypoint .ts from the package.json `types`/`main` fields.
 *
 * Mirrors the strada Assembler's `mainFile` computation: start from the declared
 * `types` (or `main`), turn the `.d.ts`/`.js` into `.ts`, then — if an
 * out-of-source build is configured (tsc `outDir`) — re-root the path from the
 * `outDir` into the `rootDir`. This correctly handles both conventional
 * `src`->`lib` layouts and in-place (`rootDir === outDir`) layouts.
 */
function deriveEntry(projectRoot: string, pkg: any): string {
  const dts: string = pkg.types ?? pkg.main ?? 'index.d.ts';
  let mainFile = dts.replace(/\.d\.ts(x?)$/, '.ts$1').replace(/\.js$/, '.ts');

  const tsc = pkg.jsii?.tsc ?? {};
  const outDir: string | undefined = tsc.outDir;
  const rootDir: string | undefined = tsc.rootDir;
  if (outDir != null) {
    // strip the outDir prefix, then prepend rootDir (if any)
    const rel = path.relative(outDir, mainFile);
    mainFile = rootDir != null ? path.join(rootDir, rel) : rel;
  }
  return path.resolve(projectRoot, mainFile);
}

/**
 * Run the ts7 backend for a package: produce and write the `.jsii` assembly.
 */
export async function ts7Emit(options: Ts7EmitOptions): Promise<Ts7EmitResult> {
  const { projectRoot, projectInfo } = options;
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const entry = deriveEntry(projectRoot, pkg);

  const host = await Ts7Host.open(projectRoot);
  try {
    const project = host.getProject();

    // Surface TypeScript compilation errors BEFORE assembling, with the same
    // reject-on-error behaviour as the default backend: a program that does not
    // compile must not produce an assembly.
    // JSII_TS7_SKIP_TYPECHECK=1 is a measurement-only switch (isolates the cost
    // of the diagnostics pass); it must never be used for real builds.
    const tsDiagnostics = process.env.JSII_TS7_SKIP_TYPECHECK ? [] : collectTsDiagnostics(project.program);
    if (tsDiagnostics.some((d) => d.category === ts.DiagnosticCategory.Error)) {
      return { typeCount: 0, emittedFiles: [], emitSkipped: true, diagnostics: tsDiagnostics };
    }

    const assembler = new Ts7Assembler(host.ts7, project, {
      packageJson: pkg,
      projectInfo,
      projectRoot,
      entry,
      assemblyName: pkg.name,
      defaultStability: pkg.stability,
      stripDeprecated: options.stripDeprecated ?? !!pkg['cdk-build']?.stripDeprecated,
      stripDeprecatedAllowListFile: options.stripDeprecatedAllowListFile,
      readme: loadReadme(projectRoot),
    });

    const assembly = assembler.assemble();

    if (process.env.JSII_TS7_TIMING) {
      LOG.info(`ts7 doc-cache hits (RPCs avoided): ${assembler.docCacheHits}`);
    }

    // Write the assembly first (the parity artifact), reusing @jsii/spec's writer
    // so the on-disk format (incl. the compressed file-redirect variant) matches
    // the strada path exactly.
    writeAssembly(projectRoot, fingerprint(assembly), { compress: options.compressAssembly ?? false });

    // Then emit JS/d.ts and inject jsii rtti (post-emit pass). An emit failure
    // fails the build (emitSkipped + a synthetic diagnostic); the assembly file
    // is left on disk to aid debugging, but the exit status reflects the error.
    let emittedFiles: string[] = [];
    try {
      ({ emittedFiles } = runTs7EmitPipeline(project, {
        projectRoot,
        assembly,
        outDir: pkg.jsii?.tsc?.outDir,
        rootDir: pkg.jsii?.tsc?.rootDir,
      }));
    } catch (err) {
      LOG.error(`ts7 backend: emit pipeline failed: ${(err as Error).stack ?? (err as Error).message}`);
      return {
        assembly,
        typeCount: Object.keys(assembly.types ?? {}).length,
        emittedFiles: [],
        emitSkipped: true,
        diagnostics: [syntheticErrorDiagnostic(`ts7 backend: emit pipeline failed: ${(err as Error).message}`)],
      };
    }

    return {
      assembly,
      typeCount: Object.keys(assembly.types ?? {}).length,
      emittedFiles,
      emitSkipped: false,
      diagnostics: tsDiagnostics, // non-error diagnostics (warnings/suggestions) pass through
    };
  } finally {
    if (process.env.JSII_TS7_TIMING) {
      const t = host.getTimingInfo?.();
      if (t?.totals) {
        LOG.info(
          `ts7 timing: requests=${t.totals.requestCount} roundTripMs=${Math.round(t.totals.roundTripMs)} ` +
            `serverTimeMs=${Math.round(t.totals.serverTimeMs ?? 0)} transportOverheadMs=${Math.round(
              t.totals.transportOverheadMs ?? 0,
            )} ` +
            `sent=${t.totals.bytesSent} recv=${t.totals.bytesReceived}`,
        );
      }
    }
    host.close();
  }
}

/**
 * Collect the program's pre-emit diagnostics (options, global, syntactic and
 * semantic) from the TS7 program and map them to `ts.Diagnostic` so the standard
 * jsii reporting pipeline prints them exactly like the default backend does.
 */
function collectTsDiagnostics(program: any): ts.Diagnostic[] {
  const call = (name: string): any[] => (typeof program[name] === 'function' ? program[name]() ?? [] : []);
  const raw: any[] = [
    ...call('getProgramDiagnostics'),
    ...call('getGlobalDiagnostics'),
    ...call('getSyntacticDiagnostics'),
    ...call('getSemanticDiagnostics'),
  ];
  const sourceFiles = new Map<string, ts.SourceFile | undefined>();
  const readSource = (fileName: string): ts.SourceFile | undefined => {
    if (!sourceFiles.has(fileName)) {
      let sf: ts.SourceFile | undefined;
      try {
        sf = ts.createSourceFile(fileName, fs.readFileSync(fileName, 'utf8'), ts.ScriptTarget.Latest, false);
      } catch {
        sf = undefined;
      }
      sourceFiles.set(fileName, sf);
    }
    return sourceFiles.get(fileName);
  };
  return raw.map((d) => toTsDiagnostic(d, readSource));
}

/**
 * Map one TS7 API diagnostic (`{ fileName, pos, end, code, category, text }`)
 * to a `ts.Diagnostic`. The file is attached as a real `ts.SourceFile` (parsed
 * with the classic compiler from the on-disk text) so `formatDiagnostic`
 * renders the same `file(line,col): error TSxxxx:` layout, with source
 * context, as the default backend. Exported for unit tests.
 */
export function toTsDiagnostic(d: any, readSource: (fileName: string) => ts.SourceFile | undefined): ts.Diagnostic {
  const category = Object.values(ts.DiagnosticCategory).includes(d.category)
    ? (d.category as ts.DiagnosticCategory)
    : ts.DiagnosticCategory.Error;
  const file = typeof d.fileName === 'string' ? readSource(d.fileName) : undefined;
  const hasRange = file != null && typeof d.pos === 'number' && typeof d.end === 'number' && d.end >= d.pos;
  return {
    category,
    code: typeof d.code === 'number' ? d.code : 0,
    file,
    start: hasRange ? d.pos : undefined,
    length: hasRange ? d.end - d.pos : undefined,
    messageText: typeof d.text === 'string' ? d.text : d.messageText ?? d.message ?? String(d),
  };
}

/** A `ts.Diagnostic`-shaped error with no source location. */
function syntheticErrorDiagnostic(messageText: string): ts.Diagnostic {
  return {
    category: ts.DiagnosticCategory.Error,
    code: 0,
    file: undefined,
    start: undefined,
    length: undefined,
    messageText,
  };
}

/**
 * Load and render the package README the same way the default backend does
 * (including literate example inclusion), so `assembly.readme` matches.
 */
function loadReadme(projectRoot: string): spec.ReadMe | undefined {
  const fileName = fs.readdirSync(projectRoot).find((file) => file.toLocaleLowerCase() === 'readme.md');
  if (fileName == null) {
    return undefined;
  }
  const readmePath = path.join(projectRoot, fileName);
  return {
    markdown: literate
      .includeAndRenderExamples(literate.loadFromFile(readmePath), literate.fileSystemLoader(projectRoot), projectRoot)
      .join('\n'),
  };
}

/** Mirror of strada `_fingerprint`: sort keys, hash, stamp `fingerprint`. */
function fingerprint(assembly: spec.Assembly): spec.Assembly {
  delete (assembly as any).fingerprint;
  const sorted = sortJson(assembly);
  const hash = crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('base64');
  return { ...sorted, fingerprint: hash };
}
