import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The result of running the jsii CLI in this process.
 */
export interface CliResult {
  /** The exit code the CLI requested (through `process.exitCode` or `process.exit()`), if any. */
  readonly exitCode: number | string | undefined;
  /** Everything written to standard output (including through `console.log`). */
  readonly stdout: string;
  /** Everything written to standard error (including through `console.error`). */
  readonly stderr: string;
}

/**
 * Creates a temporary directory containing a minimal jsii project, and returns its path.
 *
 * @param files   the files to write in the project, which are merged on top of the minimal project's files.
 *                A value of `null` removes a file from the minimal project.
 * @param pkgJson overrides for the minimal project's `package.json`.
 */
export function makeCliProject(files: Record<string, string | null> = {}, pkgJson: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsii-cli-'));
  const allFiles: Record<string, string | null> = {
    'package.json': JSON.stringify(
      {
        name: 'cli-test-package',
        version: '1.2.3',
        description: 'A package used to test the jsii CLI',
        homepage: 'https://github.com/aws/jsii-compiler',
        license: 'Apache-2.0',
        author: { name: 'John Doe' },
        repository: { type: 'git', url: 'https://github.com/aws/jsii-compiler.git' },
        main: 'index.js',
        types: 'index.d.ts',
        jsii: { targets: {} },
        ...pkgJson,
      },
      null,
      2,
    ),
    'index.ts': 'export class Klass {}',
    'README.md': '# A test package',
    ...files,
  };
  for (const [name, content] of Object.entries(allFiles)) {
    if (content == null) {
      continue;
    }
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

/**
 * Runs the jsii CLI (`src/main.ts`) inside this process, as if invoked from `cwd` with the provided arguments.
 *
 * The test file that uses this must `jest.mock('yargs', ...)` using `mockYargsToTrackParse`, so that this function can
 * wait for the (asynchronous) command handlers to complete.
 */
export async function runCli(cwd: string, ...args: string[]): Promise<CliResult> {
  const originalArgv = process.argv;
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  const originalSilence = process.env.JSII_SILENCE_SUPPORT_WARNING;

  let stdout = '';
  let stderr = '';
  const capture = (target: 'stdout' | 'stderr') =>
    jest.spyOn(process[target], 'write').mockImplementation(((chunk: string | Uint8Array) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      if (target === 'stdout') {
        stdout += text;
      } else {
        stderr += text;
      }
      return true;
    }) as any);
  // yargs terminates the process after printing the version or a usage error.
  let exitedWith: number | undefined;
  const spies = [
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitedWith = code ?? 0;
    }) as any),
    capture('stdout'),
    capture('stderr'),
    jest.spyOn(console, 'log').mockImplementation((...data) => {
      stdout += `${data.join(' ')}\n`;
    }),
    jest.spyOn(console, 'error').mockImplementation((...data) => {
      stderr += `${data.join(' ')}\n`;
    }),
    jest.spyOn(console, 'warn').mockImplementation((...data) => {
      stderr += `${data.join(' ')}\n`;
    }),
  ];

  try {
    process.argv = ['node', 'jsii', ...args];
    process.env.JSII_SILENCE_SUPPORT_WARNING = '1';
    process.exitCode = undefined;
    process.chdir(cwd);

    (globalThis as any).__jsiiCliParse = undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../src/main');
    });

    // The CLI starts asynchronously (after checking for support policy information), then parses its arguments.
    for (let attempt = 0; attempt < 500 && !(globalThis as any).__jsiiCliParse; attempt++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // A failing command handler rejects the promise, and is reported by the CLI itself.
    await (globalThis as any).__jsiiCliParse.catch(() => undefined);
    // Give the main function a chance to finish handling the result.
    await new Promise((resolve) => setImmediate(resolve));

    return { exitCode: exitedWith ?? process.exitCode, stdout, stderr };
  } finally {
    for (const spy of spies) spy.mockRestore();
    process.argv = originalArgv;
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    if (originalSilence === undefined) {
      delete process.env.JSII_SILENCE_SUPPORT_WARNING;
    } else {
      process.env.JSII_SILENCE_SUPPORT_WARNING = originalSilence;
    }
  }
}

/**
 * A `yargs` mock factory that forwards everything to the actual `yargs`, but remembers the result of `parse()` so that
 * `runCli` can wait for it.
 *
 * Usage: `jest.mock('yargs', () => mockYargsToTrackParse());`
 *
 * @param options.ignoreConflicts drops `conflicts()` declarations, to let a handler see options yargs would reject.
 */
export function mockYargsToTrackParse(options: { readonly ignoreConflicts?: boolean } = {}) {
  const wrap = (instance: any): any =>
    new Proxy(instance, {
      get(target, property) {
        if (property === '__esModule') {
          return true;
        }
        const value = target[property];
        if (typeof value !== 'function') {
          return value;
        }
        return (...originalArgs: unknown[]) => {
          let callArgs = originalArgs;
          if (property === 'command' && options.ignoreConflicts && typeof callArgs[2] === 'function') {
            // The builder of a command receives its own yargs instance: make sure that one is wrapped, too.
            const builder = callArgs[2] as (inner: any) => unknown;
            callArgs = [...callArgs.slice(0, 2), (inner: any) => builder(wrap(inner)), ...callArgs.slice(3)];
          }
          if (property === 'conflicts' && options.ignoreConflicts) {
            return wrap(target);
          }
          let result;
          try {
            result = value.apply(target, callArgs);
          } catch (error) {
            // A synchronous handler that throws makes parse() throw: record that as a rejected parse.
            if (property === 'parse') {
              (globalThis as any).__jsiiCliParse = Promise.reject(error);
            }
            throw error;
          }
          if (property === 'parse') {
            (globalThis as any).__jsiiCliParse = Promise.resolve(result);
            return result;
          }
          // Keep the chain going through the proxy (yargs returns itself, or its inner instance).
          return result != null && typeof result === 'object' && typeof result.parse === 'function'
            ? wrap(result)
            : result;
        };
      },
    });
  return wrap(jest.requireActual('yargs'));
}
