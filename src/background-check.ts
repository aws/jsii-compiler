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
import * as path from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';

/** Below this many files, starting a second TypeScript process costs more than the check takes. */
// shortcut: a fixed size; measure when the fixed cost of the second process (about 0.3s) changes.
export const MIN_FILES_FOR_BACKGROUND_CHECK = 200;

export interface BackgroundCheckOptions {
  /** The directory of the TypeScript 7 package. */
  readonly packageDir: string;
  readonly projectRoot: string;
  readonly tsconfigPath: string;
  /** The content of the tsconfig, when it is not the file's. */
  readonly tsconfigText?: string;
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

/**
 * The code of the worker thread: what `compiler.ts` does with the program in the
 * process it has open (`collectTsDiagnostics`, then `program.emit()` unless errors
 * skip it), with plain values as results. It is a string so that it runs the same
 * from `lib/` and from the sources a test runner loads.
 */
const WORKER_CODE = `
const { workerData } = require('node:worker_threads');
const d = workerData;
const plain = (diagnostic) => {
  const out = {};
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
let api;
let message;
try {
  api = new (require(d.packageDir + '/dist/api/sync/api.js').API)({ cwd: d.projectRoot });
  const fileSystem = d.tsconfigText != null
    ? require(d.packageDir + '/dist/api/fs.js').createFileSystemLayer([[d.tsconfigPath, d.tsconfigText]])
    : undefined;
  const snapshot = api.createSnapshot({ openProjects: [d.tsconfigPath], fileSystem });
  const program = snapshot.getConfiguredProject(d.tsconfigPath).program;
  const call = (name) => (typeof program[name] === 'function' ? program[name]() ?? [] : []);
  const raw = [
    ...call('getConfigFileParsingDiagnostics'),
    ...call('getProgramDiagnostics'),
    ...call('getGlobalDiagnostics'),
    ...call('getSyntacticDiagnostics'),
    ...call('getSemanticDiagnostics'),
  ];
  const diagnostics = raw.map(plain);
  const hasErrors = diagnostics.some((x) => x.category === d.errorCategory || !d.categories.includes(x.category));
  let emit;
  if (!(hasErrors && d.noEmitOnError)) {
    const result = program.emit();
    emit = {
      emitSkipped: result?.emitSkipped,
      emittedFiles: result?.emittedFiles,
      diagnostics: (result?.diagnostics ?? []).map(plain),
    };
  }
  message = { diagnostics, emit };
} catch (error) {
  message = { error: String(error && error.stack || error) };
} finally {
  try {
    api?.close();
  } catch {
    /* the process is gone */
  }
}
d.port.postMessage(message);
Atomics.store(d.done, 0, 1);
Atomics.notify(d.done, 0);
`;

/** A type check and emit running in a worker thread (see the file header). */
export class BackgroundCheck {
  /** Start it. Returns `undefined` when no worker can be started: do the work in this process then. */
  public static start(options: BackgroundCheckOptions): BackgroundCheck | undefined {
    try {
      const done = new Int32Array(new SharedArrayBuffer(4));
      const { port1, port2 } = new MessageChannel();
      const worker = new Worker(WORKER_CODE, {
        eval: true,
        workerData: { ...options, tsconfigPath: path.resolve(options.tsconfigPath), done, port: port2 },
        transferList: [port2],
      });
      // The worker does not keep the process alive; the build waits for it.
      worker.unref();
      return new BackgroundCheck(worker, done, port1);
    } catch {
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
      Atomics.wait(this.done, 0, 0);
      const message = receiveMessageOnPort(this.port as any)?.message;
      this.result = message != null && message.error == null ? message : null;
      void this.worker.terminate();
      this.port.close();
    }
    return this.result ?? undefined;
  }
}

type MessagePort = import('node:worker_threads').MessagePort;
