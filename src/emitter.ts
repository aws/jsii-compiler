/*
 * ---------------------------------------------------------------------------
 * Emit: produce the JS / d.ts artifacts via the TypeScript 7 `program.emit()`,
 * then add the jsii runtime type information (see transforms/runtime-info.ts)
 * and the --add-deprecation-warnings calls to the emitted `.js`. The previous
 * implementation did that with `CustomTransformer`s during emit; the
 * TypeScript 7 API has no transformer hook, so this is a post-emit text pass
 * that produces the same code.
 * ---------------------------------------------------------------------------
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as spec from '@jsii/spec';
import * as log4js from 'log4js';

import { TypeScriptApi, TypeScriptProject } from './compiler-host';
import { DeprecationWarningsInjector } from './transforms/deprecation-warnings';
import { EmittedFile, pairClasses, prependStatements, rewrittenBodyEdits } from './transforms/emitted-js';
import { rttiInsertions } from './transforms/runtime-info';
import { insertIntoEmittedJs, Insertion } from './transforms/source-map';

const LOG = log4js.getLogger('jsii/emitter');

export interface EmitProjectOptions {
  readonly projectRoot: string;
  readonly assembly: spec.Assembly;
  /** tsc `outDir` from the jsii config (for mapping source -> emitted js path). */
  readonly outDir?: string;
  /** tsc `rootDir` from the jsii config. */
  readonly rootDir?: string;
  /** Adds the calls into `.warnings.jsii.js` (`--add-deprecation-warnings`). */
  readonly deprecationWarnings?: DeprecationWarningsInjector;
  /**
   * Classes removed from the assembly by --strip-deprecated. Their code is
   * still emitted, and the classic compiler gave them rtti too.
   */
  readonly strippedClasses?: readonly spec.ClassType[];
}

export interface EmitProjectResult {
  readonly emittedFiles: string[];
}

/** The jsii runtime-type-information symbol key (see @jsii/runtime). */
const RTTI_SYMBOL = 'jsii.rtti';

/**
 * Emit JS/d.ts for the whole project in a SINGLE `program.emit()` call. The
 * server writes every output file directly to disk and returns only file names,
 * so the ~345MB emit payload (aws-cdk-lib) never crosses the RPC channel; jsii
 * then reads back only the class-bearing `.js` files to add the jsii rtti
 * marker.
 *
 * NOTE (perf/stability): emitting per source file would issue one round-trip
 * per file and, at aws-cdk-lib scale (~thousands of files), was observed to
 * destabilize the out-of-process session (EPIPE / process exit). The
 * whole-project emit collapses this to one request.
 */
export function emitProject(
  ts: TypeScriptApi,
  project: TypeScriptProject,
  options: EmitProjectOptions,
): EmitProjectResult {
  const { program } = project;
  const root = options.projectRoot;
  const assembly = options.assembly;

  // Map the emitted `.js` path (relative to root, normalized) -> classes to stamp
  // with rtti. Derive the emitted path from each class's source `locationInModule`
  // via the tsc outDir/rootDir transform, so it is robust to duplicate basenames
  // across modules (common at aws-cdk-lib scale). We also index by basename as a
  // fallback for simple layouts.
  const classesByJsRel = new Map<string, Array<{ name: string; fqn: string; relSrc: string; inFileName?: string }>>();
  // Basename fallback index: basename -> the set of jsRel paths that share it.
  // The fallback is only safe when a basename is unambiguous (single jsRel).
  const jsRelsByBasename = new Map<string, Set<string>>();
  for (const type of [...Object.values(assembly.types ?? {}), ...(options.strippedClasses ?? [])]) {
    if ((type as any).kind !== spec.TypeKind.Class) {
      continue;
    }
    const relSrc: string | undefined = (type as any).locationInModule?.filename;
    if (!relSrc) {
      continue;
    }
    const symbolId: string | undefined = type.symbolId;
    const inFileName = symbolId?.slice(symbolId.lastIndexOf(':') + 1);
    const entry = { name: type.name, fqn: type.fqn, relSrc, inFileName };
    const jsRel = sourceRelToJsRel(relSrc, options.outDir, options.rootDir);
    if (!classesByJsRel.has(jsRel)) {
      classesByJsRel.set(jsRel, []);
    }
    classesByJsRel.get(jsRel)!.push(entry);
    const base = path.basename(jsRel);
    if (!jsRelsByBasename.has(base)) {
      jsRelsByBasename.set(base, new Set());
    }
    jsRelsByBasename.get(base)!.add(jsRel);
  }

  const emittedFiles: string[] = [];

  // Whole-project emit (see the function docblock for why this is one RPC).
  // `program.emit()` writes to the host filesystem and returns
  // { emitSkipped, diagnostics, emittedFiles } with absolute file names.
  const result = program.emit();
  if (result?.emitSkipped) {
    const reasons = (result.diagnostics ?? []).map((d: any) => d.text ?? d.messageText ?? String(d)).slice(0, 5);
    throw new Error(`TypeScript emit was skipped${reasons.length ? `: ${reasons.join('; ')}` : ''}`);
  }
  let outputNames: string[] | undefined = result?.emittedFiles;
  if (outputNames === undefined) {
    // emittedFiles may be omitted by the server; fall back to the class-bearing
    // JS files we can derive locally (sufficient for rtti injection).
    outputNames = [...classesByJsRel.keys()];
  }

  const emittedJsRels = new Set(
    outputNames.filter((n) => /\.js$/.test(n)).map((n) => normalizeRel(path.relative(root, path.resolve(root, n)))),
  );
  for (const name of outputNames) {
    const outPath = path.resolve(root, name);
    emittedFiles.push(outPath);

    if (!/\.js$/.test(name)) {
      continue; // non-JS (d.ts / maps): already written by the server, nothing to do
    }
    const jsRel = normalizeRel(path.relative(root, outPath));
    let classesHere = classesByJsRel.get(jsRel);
    if (!classesHere) {
      // Fall back to basename matching ONLY when it is unambiguous (a single
      // source file maps to this basename) and that file was not emitted where
      // its path maps to (else this is another file with the same name, such as
      // an `index.js` that only re-exports); otherwise skip and say so.
      const candidates = jsRelsByBasename.get(path.basename(name));
      if (candidates?.size === 1 && !emittedJsRels.has([...candidates][0])) {
        classesHere = classesByJsRel.get([...candidates][0]);
      } else if (candidates && candidates.size > 1) {
        LOG.warn(
          `ts backend: skipping rtti injection for ${jsRel} (ambiguous basename across ${candidates.size} files)`,
        );
      }
    }
    if (!classesHere || !classesHere.length) {
      if (options.deprecationWarnings) {
        // No jsii class, but the classic transformer still rewrote the bodies of the file (see rewrittenBodyEdits).
        const js = fs.readFileSync(outPath, 'utf8');
        const updated = withRewrittenBodies(ts, project, outPath, js);
        if (updated !== js) {
          fs.writeFileSync(outPath, updated, { encoding: 'utf8' });
        }
      }
      continue; // JS without exported classes: no rtti to inject, leave as written
    }
    // Read the server-written JS, add the rtti (and deprecation warning calls), write it back.
    // Only a small fraction of files (those declaring exported classes) are touched.
    const js = fs.readFileSync(outPath, 'utf8');
    fs.writeFileSync(outPath, addToEmittedJs(ts, project, options, outPath, js, classesHere), { encoding: 'utf8' });
  }

  return { emittedFiles };
}

/**
 * The emitted `.js` of a file with jsii classes, with the rtti and (with
 * --add-deprecation-warnings) the deprecation warning calls added.
 */
function addToEmittedJs(
  ts: TypeScriptApi,
  project: TypeScriptProject,
  options: EmitProjectOptions,
  jsFile: string,
  jsText: string,
  classesHere: ReadonlyArray<{ name: string; fqn: string; relSrc: string; inFileName?: string }>,
): string {
  const tsFile = path.resolve(options.projectRoot, classesHere[0].relSrc);
  const tsSource = project.program.getSourceFile(tsFile);
  const retained = tsSource != null ? project.api.createSourceFile(jsFile, jsText) : undefined;
  try {
    const jsSource = retained?.sourceFile;
    const classes = jsSource != null ? pairClasses(tsSource, jsSource, ts.SyntaxKind) : undefined;
    if (classes == null) {
      LOG.warn(`ts backend: the classes of ${jsFile} do not match ${tsFile}; rtti appended, no deprecation warnings`);
      const js = options.deprecationWarnings ? withRewrittenBodies(ts, project, jsFile, jsText) : jsText;
      // @TODO(NEXT): fallback rtti form, different from the static member main emits; it only hides a pairing miss.
      // After 7.1's first release: make this the only rtti form, or fail the build instead of warning.
      return injectRtti(js, rttiSnippet(classesHere, options.assembly.version));
    }
    const file: EmittedFile = { jsFile, jsText, jsSource, tsFile, tsSource, k: ts.SyntaxKind, classes };

    const edits: Insertion[] = [];
    const prepend: string[] = [];
    const calls = options.deprecationWarnings?.callInsertions(file, options.assembly, options.projectRoot);
    const rtti = rttiInsertions(
      file,
      // A class exported under several fqns (re-exported from submodules) gets the one visited last, as the
      // classic compiler's registration did: the assembly lists types in the classic visit order.
      new Map(classesHere.filter((c) => c.inFileName != null).map((c) => [c.inFileName!, c.fqn])),
      options.assembly.version,
      project.program.getCompilerOptions(),
    );
    for (const added of [calls, rtti]) {
      edits.push(...(added?.edits ?? []));
      if (added?.prepend != null) {
        prepend.push(added.prepend);
      }
    }
    if (prepend.length > 0) {
      edits.push(...prependStatements(jsText, jsSource, tsSource, ts.SyntaxKind, prepend));
    }
    if (options.deprecationWarnings) {
      // The rtti may remove the same comments (in a constructor the emit made up): keep one of each edit.
      const keys = new Set(edits.map((e) => `${e.offset}:${e.length ?? 0}:${e.text}`));
      edits.push(
        ...rewrittenBodyEdits(jsText, jsSource, ts.SyntaxKind).filter(
          (e) => !keys.has(`${e.offset}:${e.length ?? 0}:${e.text}`),
        ),
      );
    }
    return insertIntoEmittedJs(jsFile, jsText, edits);
  } finally {
    retained?.dispose();
  }
}

/** The emitted `.js` with the edits of `rewrittenBodyEdits` applied. */
function withRewrittenBodies(ts: TypeScriptApi, project: TypeScriptProject, jsFile: string, jsText: string): string {
  // shortcut: a file without any comment has nothing to lose; skip parsing it.
  if (!/\/\/(?!# sourceMappingURL=)|\/\*/.test(jsText)) {
    return jsText;
  }
  const retained = project.api.createSourceFile(jsFile, jsText);
  try {
    return insertIntoEmittedJs(jsFile, jsText, rewrittenBodyEdits(jsText, retained.sourceFile, ts.SyntaxKind));
  } finally {
    retained.dispose();
  }
}

/** Normalize a relative path for use as a map key (posix separators). */
function normalizeRel(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Transform a source path (relative to root, e.g. `src/foo.ts`) into the emitted
 * JS path (relative to root, e.g. `lib/foo.js`) using the tsc outDir/rootDir.
 */
function sourceRelToJsRel(relSrc: string, outDir?: string, rootDir?: string): string {
  let p = relSrc.replace(/\.tsx?$/, '.js');
  if (rootDir != null && outDir != null) {
    const rootRel = normalizeRel(path.relative(rootDir, p));
    if (!rootRel.startsWith('..')) {
      p = path.join(outDir, rootRel);
    }
  }
  return normalizeRel(p);
}

/**
 * Fallback for a file whose classes cannot be paired with its `.ts` file (see
 * `addToEmittedJs`): the rtti is set after the classes are defined instead.
 *
 * Insert the rtti snippet into emitted JS. When the file ends with a
 * `//# sourceMappingURL=` comment, the snippet is inserted BEFORE it so the
 * marker comment stays the last line of the file (tooling convention).
 * Exported for unit tests.
 */
export function injectRtti(source: string, snippet: string): string {
  const m = /\n\/\/# sourceMappingURL=[^\n]*\s*$/.exec(source);
  if (m) {
    return source.slice(0, m.index) + snippet.replace(/\n$/, '') + source.slice(m.index);
  }
  return source + snippet;
}

/**
 * Build the post-emit rtti injection snippet for a set of classes, matching the
 * shape the classic runtime-info transformer produces at runtime.
 * Exported for unit tests.
 */
export function rttiSnippet(classes: ReadonlyArray<{ name: string; fqn: string }>, version: string): string {
  let snippet = '\n// jsii runtime type information (injected after emit)\n';
  for (const c of classes) {
    snippet +=
      `try { Object.defineProperty(exports.${c.name}, Symbol.for("${RTTI_SYMBOL}"), ` +
      `{ value: { fqn: ${JSON.stringify(c.fqn)}, version: ${JSON.stringify(
        version,
      )} }, configurable: true }); } catch (e) { }\n`;
  }
  return snippet;
}
