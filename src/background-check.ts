/*
 * ---------------------------------------------------------------------------
 * The type check and the emit of a project, in a second TypeScript 7 process
 * that runs while jsii assembles.
 *
 * jsii asks the TypeScript 7 process one question at a time and waits for each
 * answer, so that process is idle while jsii works on the answer, and the cores
 * of the machine with it. The type check of the whole program (the program's
 * diagnostics) and the emit do not depend on what the assembler learns, so a
 * worker thread runs them in a process of its own meanwhile, and the build
 * collects the results when it needs them.
 * ---------------------------------------------------------------------------
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isMainThread, MessageChannel, receiveMessageOnPort, Worker, workerData } from 'node:worker_threads';
import * as log4js from 'log4js';

/** Below this many files, starting a second TypeScript process costs more than the check takes. */
// shortcut: a fixed size; measure when the fixed cost of the second process (about 0.3s) changes.
export const MIN_FILES_FOR_BACKGROUND_CHECK = 200;

export interface BackgroundCheckOptions {
  /** The directory of the TypeScript 7 package. */
  readonly packageDir: string;
  readonly projectRoot: string;
  readonly tsconfigPath: string;
  /** `DiagnosticCategory` values of jsii: of an error, and all of them (others are errors too). */
  readonly errorCategory: number;
  readonly categories: readonly number[];
  /** Whether errors skip the emit. */
  readonly noEmitOnError: boolean;
}

export interface BackgroundCheckResult {
  /** The program's diagnostics: config file, options, global, syntactic and semantic, in this order. */
  readonly diagnostics: any[];
  /** The result of `program.emit()`; absent when it did not run (`noEmitOnError` and errors). */
  readonly emit?: { emitSkipped?: boolean; emittedFiles?: string[]; diagnostics: any[] };
}

const LOG = log4js.getLogger('jsii/background-check');

/** How long the worker has to start. */
const START_TIMEOUT_MS = 10_000;
/**
 * How long the build waits for a worker that started: a worker that dies (out of memory, killed) cannot be told
 * from a slow one while this thread is blocked.
 */
// shortcut: a fixed limit; make it a function of the size of the project if a slower build ever reaches it.
const MAX_WAIT_MS = 30 * 60_000;

/** What marks the `workerData` of the thread this file starts (jest's own workers have other data). */
const WORKER_KIND = 'jsii-background-check';

/**
 * The worker thread: what `compiler.ts` does with the program in the process it has
 * open (`collectTsDiagnostics`, then `program.emit()` unless errors skip it), with
 * plain values as results.
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
  } finally {
    try {
      api?.close();
    } catch {
      /* the process is gone */
    }
  }
  data.port.postMessage(message);
  Atomics.store(data.done, 0, 1);
  Atomics.notify(data.done, 0);
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
      const done = new Int32Array(new SharedArrayBuffer(8));
      const { port1, port2 } = new MessageChannel();
      const data: BackgroundCheckOptions & WorkerData = {
        ...options,
        tsconfigPath: path.resolve(options.tsconfigPath),
        kind: WORKER_KIND,
        done,
        port: port2,
      };
      // This file is the worker too. Run from sources (the tests) it is TypeScript, which a worker cannot load: use
      // the compiled file next to them (`lib/`, built before the tests run), and none when it is not built.
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

  private constructor(
    private readonly worker: Worker,
    private readonly done: Int32Array,
    private readonly port: MessagePort,
  ) {}

  /**
   * Wait for the results (this thread has nothing else to do by then). `undefined`
   * when the worker failed: do the work in this process then.
   */
  public wait(): BackgroundCheckResult | undefined {
    if (this.result === undefined) {
      // The worker says it is running before it does anything: one that does not start would be waited for forever.
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
      void this.worker.terminate();
      this.port.close();
    }
    return this.result ?? undefined;
  }
}

type MessagePort = import('node:worker_threads').MessagePort;
