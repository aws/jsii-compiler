/*
 * ---------------------------------------------------------------------------
 * The background check: the type check and the emit of a project, run by a
 * worker thread with its own TypeScript 7 process while jsii assembles.
 *
 * jsii asks its TypeScript 7 process one question at a time and waits for each
 * answer. While jsii works on an answer, that process is idle, and so are the
 * other cores of the machine. The type check of the whole program and the emit
 * do not depend on what the assembler learns. So a worker thread runs them in
 * a TypeScript process of its own meanwhile, and the build collects the results
 * when it needs them.
 * ---------------------------------------------------------------------------
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isMainThread, MessageChannel, receiveMessageOnPort, Worker, workerData } from 'node:worker_threads';
import * as log4js from 'log4js';
import { loadTypeScriptApi } from './compiler-host';
import { jsClassIndices, withoutSourceMapComment } from './transforms/emitted-js';

/** Below this many files, starting the worker's TypeScript process costs more time than the background check saves. */
// shortcut: a fixed size. Measure again when the start-up cost of that process, about 0.3s, changes.
export const MIN_FILES_FOR_BACKGROUND_CHECK = 200;

export interface BackgroundCheckOptions {
  /** The directory of the TypeScript 7 package. */
  readonly packageDir: string;
  readonly projectRoot: string;
  readonly tsconfigPath: string;
  /** jsii's `DiagnosticCategory` value for an error, and all its values. A category that is not listed counts as an error. */
  readonly errorCategory: number;
  readonly categories: readonly number[];
  /** Whether errors skip the emit. */
  readonly noEmitOnError: boolean;
}

export interface BackgroundCheckResult {
  /** The program's diagnostics: config file, options, global, syntactic and semantic, in this order. */
  readonly diagnostics: any[];
  /** The result of `program.emit()`. It is absent when the emit did not run, because of errors and `noEmitOnError`. */
  readonly emit?: {
    emitSkipped?: boolean;
    emittedFiles?: string[];
    diagnostics: any[];
    /**
     * The encoded `createSourceFile` result of an emitted `.js` file, when the worker parsed that exact text (see
     * `withoutSourceMapComment`) already. The caller parses the file itself otherwise.
     */
    parsedJs?: (jsFile: string, text: string) => ParsedJs | undefined;
  };
}

/** The encoded `createSourceFile` result of an emitted `.js` file, and the node indices of its classes. */
export interface ParsedJs {
  readonly bytes: Uint8Array;
  readonly jsClassIndices: readonly number[];
}

const LOG = log4js.getLogger('jsii/background-check');

/** How long the worker has to start. */
const START_TIMEOUT_MS = 10_000;
/**
 * How long the build waits for a worker that started. While this thread is blocked, it cannot tell a worker that
 * died, for example because it ran out of memory or was killed, from a slow one.
 */
// shortcut: a fixed limit; make it a function of the size of the project if a slower build ever reaches it.
const MAX_WAIT_MS = 30 * 60_000;

/** What marks the `workerData` of the thread this file starts (jest's own workers have other data). */
const WORKER_KIND = 'jsii-background-check';

/**
 * The worker thread. It does what `compiler.ts` does with the program in its own
 * TypeScript process: it collects the diagnostics like `collectTsDiagnostics`,
 * then calls `program.emit()` unless errors and `noEmitOnError` skip it. The
 * results are plain values.
 */
function runWorker(data: BackgroundCheckOptions & WorkerData): void {
  Atomics.store(data.done, 1, 1);
  const plain = (diagnostic: any) => {
    const out: any = {};
    for (const key of ['category', 'fileName', 'pos', 'end', 'code', 'text', 'messageText', 'message']) {
      if (diagnostic[key] !== undefined) {
        out[key] = diagnostic[key];
      }
    }
    if (out.text === undefined && out.messageText === undefined && out.message === undefined) {
      out.text = String(diagnostic);
    }
    return out;
  };
  let api: any;
  let message: any;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
    api = new (require(`${data.packageDir}/dist/api/sync/api.js`).API)({ cwd: data.projectRoot });
    /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
    const snapshot = api.createSnapshot({ openProjects: [data.tsconfigPath] });
    const program = snapshot.getConfiguredProject(data.tsconfigPath).program;
    const call = (name: string): any[] => (typeof program[name] === 'function' ? program[name]() ?? [] : []);
    const diagnostics = [
      ...call('getConfigFileParsingDiagnostics'),
      ...call('getProgramDiagnostics'),
      ...call('getGlobalDiagnostics'),
      ...call('getSyntacticDiagnostics'),
      ...call('getSemanticDiagnostics'),
    ].map(plain);
    const hasErrors = diagnostics.some(
      (x) => x.category === data.errorCategory || !data.categories.includes(x.category),
    );
    let emit;
    if (!(hasErrors && data.noEmitOnError)) {
      const result = program.emit();
      emit = {
        emitSkipped: result?.emitSkipped,
        emittedFiles: result?.emittedFiles,
        diagnostics: (result?.diagnostics ?? []).map(plain),
      };
    }
    message = { diagnostics, emit };
  } catch (error: any) {
    message = { error: String(error?.stack ?? error) };
  }
  data.port.postMessage(message);
  Atomics.store(data.done, 0, 1);
  Atomics.notify(data.done, 0);
  try {
    if (message.emit != null && !message.emit.emitSkipped) {
      parseEmittedJs(api, data, message.emit.emittedFiles ?? []);
    }
  } catch {
    /* the build parses the remaining files itself */
  } finally {
    try {
      api?.close();
    } catch {
      /* the process is gone */
    }
  }
}

/**
 * While the build still assembles, parse the emitted `.js` files that the emit post-pass parses (those with classes),
 * in the order it visits them, and send each encoded result over. The build stops this once it no longer needs them.
 */
function parseEmittedJs(api: any, data: BackgroundCheckOptions & WorkerData, emittedFiles: readonly string[]): void {
  const { SyntaxKind } = loadTypeScriptApi();
  try {
    // This work only matters if it is ahead of the assembler: let the assembler's processes have the CPUs first.
    os.setPriority(api.client.channel.child.pid, 10);
  } catch {
    /* keep the priority */
  }
  for (const name of emittedFiles) {
    if (Atomics.load(data.done, 2) !== 0) {
      return;
    }
    if (!/\.js$/.test(name)) {
      continue;
    }
    const jsFile = path.resolve(data.projectRoot, name);
    const text = withoutSourceMapComment(fs.readFileSync(jsFile, 'utf8'));
    if (!/\bclass\b/.test(text)) {
      continue;
    }
    const retained = api.createSourceFile(jsFile, text);
    let buffer: ArrayBuffer;
    let classes: number[];
    try {
      const view: DataView = retained.sourceFile.view;
      buffer = new ArrayBuffer(view.byteLength);
      new Uint8Array(buffer).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      classes = jsClassIndices(retained.sourceFile, SyntaxKind);
    } finally {
      retained.dispose();
    }
    data.port.postMessage({ jsFile, text, bytes: new Uint8Array(buffer), jsClassIndices: classes }, [buffer]);
  }
}

interface WorkerData {
  readonly kind: typeof WORKER_KIND;
  readonly done: Int32Array;
  readonly port: MessagePort;
}

if (!isMainThread && workerData?.kind === WORKER_KIND) {
  runWorker(workerData);
}

/** A type check and emit running in a worker thread (see the file header). */
export class BackgroundCheck {
  /** Start it. Returns `undefined` when no worker can be started: do the work in this process then. */
  public static start(options: BackgroundCheckOptions): BackgroundCheck | undefined {
    try {
      // [finished, started, stop parsing]
      const done = new Int32Array(new SharedArrayBuffer(12));
      const { port1, port2 } = new MessageChannel();
      const data: BackgroundCheckOptions & WorkerData = {
        ...options,
        tsconfigPath: path.resolve(options.tsconfigPath),
        kind: WORKER_KIND,
        done,
        port: port2,
      };
      // This file is also the worker's code. When the tests run it from the sources, it is TypeScript, which a worker
      // cannot load. The worker then uses the compiled file in `lib/`, which is built before the tests run. When that
      // file does not exist, no worker starts.
      const file = __filename.endsWith('.ts')
        ? path.resolve(__dirname, '..', 'lib', 'background-check.js')
        : __filename;
      if (!fs.existsSync(file)) {
        LOG.debug(`no worker to start: ${file} does not exist`);
        return undefined;
      }
      const worker = new Worker(file, { workerData: data, transferList: [port2] });
      // The worker does not keep the process alive; the build waits for it.
      worker.unref();
      return new BackgroundCheck(worker, done, port1);
    } catch (error: any) {
      LOG.debug(`the worker did not start: ${String(error?.message ?? error)}`);
      return undefined;
    }
  }

  private result?: BackgroundCheckResult | null;
  /** The emitted `.js` files the worker parsed, until the emit post-pass takes them. */
  private readonly parsed = new Map<string, ParsedJs & { text: string }>();
  private stopped = false;

  private constructor(
    private readonly worker: Worker,
    private readonly done: Int32Array,
    private readonly port: MessagePort,
  ) {}

  /**
   * Waits for the results. By the time this is called, this thread has nothing else
   * to do. Returns `undefined` when the worker failed; the caller then does the work
   * in its own process. After an emit, the worker goes on parsing the emitted `.js`
   * files (`parsedJs`) until the next call, which stops it.
   */
  public wait(): BackgroundCheckResult | undefined {
    if (this.result === undefined) {
      // The worker marks that it runs before it does anything else. So a worker that never starts is noticed
      // after START_TIMEOUT_MS, and the build does not wait for it forever.
      let reason: string | undefined;
      for (let waited = 0; Atomics.load(this.done, 0) === 0; waited += 1000) {
        if (waited >= START_TIMEOUT_MS && Atomics.load(this.done, 1) === 0) {
          reason = `it did not start in ${START_TIMEOUT_MS / 1000}s`;
          break;
        }
        if (waited >= MAX_WAIT_MS) {
          reason = `it did not finish in ${MAX_WAIT_MS / 60_000} minutes`;
          break;
        }
        Atomics.wait(this.done, 0, 0, 1000);
      }
      const message = receiveMessageOnPort(this.port as any)?.message;
      this.result = message != null && message.error == null ? message : null;
      if (this.result == null) {
        LOG.debug(`the worker failed, checking and emitting in this process: ${message?.error ?? reason}`);
      }
      if (this.result?.emit != null && !this.result.emit.emitSkipped) {
        // The worker goes on parsing the emitted `.js` files for the emit post-pass; a later call stops it.
        this.result.emit.parsedJs = (jsFile, text) => this.parsedJs(jsFile, text);
        return this.result;
      }
    }
    this.stop();
    return this.result ?? undefined;
  }

  /** The encoded parse of an emitted `.js` file, if the worker sent it for this exact text. */
  private parsedJs(jsFile: string, text: string): ParsedJs | undefined {
    if (!this.stopped) {
      for (
        let next = receiveMessageOnPort(this.port as any);
        next != null;
        next = receiveMessageOnPort(this.port as any)
      ) {
        this.parsed.set(next.message.jsFile, next.message);
      }
    }
    const entry = this.parsed.get(jsFile);
    this.parsed.delete(jsFile);
    return entry?.text === text ? entry : undefined;
  }

  private stop(): void {
    if (!this.stopped) {
      this.stopped = true;
      Atomics.store(this.done, 2, 1);
      void this.worker.terminate();
      this.port.close();
      this.parsed.clear();
    }
  }
}

type MessagePort = import('node:worker_threads').MessagePort;
