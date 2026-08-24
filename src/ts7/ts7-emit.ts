/*
 * ---------------------------------------------------------------------------
 * Experimental TypeScript 7 (tsgo) backend for jsii.
 *
 * Emit pipeline: produce the JS / d.ts artifacts via the patched TS7
 * `program.getEmitOutput`, then run the jsii runtime-type-information (rtti)
 * post-emit pass that injects the `Symbol.for("jsii.rtti")` marker onto each
 * exported class. This mirrors what strada does with a `CustomTransformer`
 * (src/transforms/runtime-info.ts), but as a post-emit text pass over the
 * emitted `.js` (the injected rtti was verified byte-identical to strada's at
 * runtime on real packages).
 *
 * Out of scope for this experimental phase: the `.warnings.jsii.js`
 * generation (deprecation-warnings) and the deprecated-remover emit surgery.
 * ---------------------------------------------------------------------------
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as spec from '@jsii/spec';
import * as log4js from 'log4js';

import { Ts7Project } from './ts7-host';

const LOG = log4js.getLogger('jsii/ts7');

export interface Ts7EmitPipelineOptions {
  readonly projectRoot: string;
  readonly assembly: spec.Assembly;
  /** tsc `outDir` from the jsii config (for mapping source -> emitted js path). */
  readonly outDir?: string;
  /** tsc `rootDir` from the jsii config. */
  readonly rootDir?: string;
}

export interface Ts7EmitPipelineResult {
  readonly emittedFiles: string[];
}

/** The jsii runtime-type-information symbol key (see @jsii/runtime). */
const RTTI_SYMBOL = 'jsii.rtti';

/**
 * Emit JS/d.ts for the whole project in a SINGLE `getEmitOutput({ writeToDisk })`
 * call. The server writes every output file directly to disk and returns only
 * file names, so the ~345MB emit payload never crosses the RPC channel; jsii then
 * reads back only the class-bearing `.js` files to append the jsii rtti marker.
 *
 * NOTE (perf/stability): emitting per-source-file (calling `getEmitOutput(sf)`
 * once per file) issues one RPC round-trip per file and, at aws-cdk-lib scale
 * (~thousands of files), destabilizes the out-of-process tsgo session (observed
 * EPIPE / process exit). The API supports a whole-project emit when called with
 * no target file (Go side emits in parallel and collects under a mutex), which
 * collapses this to one RPC. This is also a useful design data point for the
 * upstream API.
 */
export function runTs7EmitPipeline(project: Ts7Project, options: Ts7EmitPipelineOptions): Ts7EmitPipelineResult {
  const { program } = project;
  const root = options.projectRoot;
  const assembly = options.assembly;

  // Map the emitted `.js` path (relative to root, normalized) -> classes to stamp
  // with rtti. Derive the emitted path from each class's source `locationInModule`
  // via the tsc outDir/rootDir transform, so it is robust to duplicate basenames
  // across modules (common at aws-cdk-lib scale). We also index by basename as a
  // fallback for simple layouts.
  const classesByJsRel = new Map<string, Array<{ name: string; fqn: string }>>();
  // Basename fallback index: basename -> the set of jsRel paths that share it.
  // The fallback is only safe when a basename is unambiguous (single jsRel).
  const jsRelsByBasename = new Map<string, Set<string>>();
  for (const [fqn, type] of Object.entries(assembly.types ?? {})) {
    if ((type as any).kind !== spec.TypeKind.Class) {
      continue;
    }
    const relSrc: string | undefined = (type as any).locationInModule?.filename;
    if (!relSrc) {
      continue;
    }
    const entry = { name: (type as any).name, fqn };
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
  // Two API generations are supported:
  //   - upstream typescript-go `program.emit()` (writes to the host filesystem,
  //     returns { emitSkipped, diagnostics, emittedFiles });
  //   - the earlier fork-only `program.getEmitOutput({ writeToDisk: true })`
  //     (same disk-write semantics, returns { outputFiles: [{ name }] }).
  let outputNames: string[] | undefined;
  if (typeof program.emit === 'function') {
    const result = program.emit();
    outputNames = result?.emittedFiles;
    if (outputNames === undefined && !result?.emitSkipped) {
      // emittedFiles may be omitted by the server; fall back to the class-bearing
      // JS files we can derive locally (sufficient for rtti injection).
      outputNames = [...classesByJsRel.keys()];
    }
  } else {
    const emitOutput = (program.getEmitOutput as (opts?: any) => any)({ writeToDisk: true });
    outputNames = emitOutput?.outputFiles?.map((f: any) => f.name);
  }
  if (!outputNames) {
    return { emittedFiles };
  }

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
      // source file maps to this basename); otherwise skip and say so.
      const candidates = jsRelsByBasename.get(path.basename(name));
      if (candidates?.size === 1) {
        classesHere = classesByJsRel.get([...candidates][0]);
      } else if (candidates && candidates.size > 1) {
        LOG.warn(
          `ts7 backend: skipping rtti injection for ${jsRel} (ambiguous basename across ${candidates.size} files)`,
        );
      }
    }
    if (!classesHere || !classesHere.length) {
      continue; // JS without exported classes: no rtti to inject, leave as written
    }
    // Read the server-written JS, inject the rtti snippet, write it back. Only a
    // small fraction of files (those declaring exported classes) are touched.
    const onDisk = fs.readFileSync(outPath, 'utf8');
    fs.writeFileSync(outPath, injectRtti(onDisk, rttiSnippet(classesHere, assembly.version)), { encoding: 'utf8' });
  }

  return { emittedFiles };
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
export function rttiSnippet(classes: Array<{ name: string; fqn: string }>, version: string): string {
  let snippet = '\n// jsii runtime type information (injected by the ts7 backend, post-emit)\n';
  for (const c of classes) {
    snippet +=
      `try { Object.defineProperty(exports.${c.name}, Symbol.for("${RTTI_SYMBOL}"), ` +
      `{ value: { fqn: ${JSON.stringify(c.fqn)}, version: ${JSON.stringify(
        version,
      )} }, configurable: true }); } catch (e) { }\n`;
  }
  return snippet;
}
