import * as util from 'node:util';

type ConsoleMethod = 'error' | 'log' | 'warn';

/**
 * Records what is written with `console.error`, `console.log` or `console.warn`, so that a test can check what a user
 * would see. Nothing is printed while it records.
 */
export class OutputCapture {
  private readonly lines = new Array<string>();
  private readonly originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();

  public constructor(...methods: ConsoleMethod[]) {
    for (const method of methods.length > 0 ? methods : (['error', 'log', 'warn'] as const)) {
      this.originals.set(method, console[method]);
      console[method] = (...args: unknown[]) => {
        this.lines.push(util.format(...args));
      };
    }
  }

  /** Everything that was written so far, without colors, one line per call. */
  public get output(): string {
    return this.lines.map((line) => line.replace(/\u001b\[[\d;]*m/g, '')).join('\n');
  }

  /** Stops recording. */
  public stop() {
    for (const [method, original] of this.originals) {
      console[method] = original;
    }
    this.originals.clear();
  }
}

/** Runs `block`, and returns what it wrote with the console next to its result. */
export function captureOutput<T>(block: () => T, ...methods: ConsoleMethod[]): { result: T; output: string } {
  const capture = new OutputCapture(...methods);
  try {
    const result = block();
    return { result, output: capture.output };
  } finally {
    capture.stop();
  }
}
