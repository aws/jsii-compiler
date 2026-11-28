import * as cluster from 'node:cluster';
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
  return runCliWithEnv({}, cwd, ...args);
}

/**
 * Like `runCli`, with changes to the environment variables the CLI sees. The CLI is run with the support policy
 * information silenced (`JSII_SILENCE_SUPPORT_WARNING=1`), unless `env` says otherwise. A value of `undefined` removes
 * the variable.
 */
export async function runCliWithEnv(
  env: Record<string, string | undefined>,
  cwd: string,
  ...args: string[]
): Promise<CliResult> {
  const originalArgv = process.argv;
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  const originalEnv = { ...process.env };
  // Each fresh copy of log4js listens to the cluster messages. A real CLI loads it once, here it is loaded on every run,
  // so the listeners are removed again. Otherwise Node.js warns about a possible memory leak in the middle of the output.
  const originalClusterListeners = clusterEmitter().listeners('message');

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
    for (const [name, value] of Object.entries({ JSII_SILENCE_SUPPORT_WARNING: '1', ...env })) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
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
    for (const listener of clusterEmitter().listeners('message')) {
      if (!originalClusterListeners.includes(listener)) {
        clusterEmitter().removeListener('message', listener as (...args: any[]) => void);
      }
    }
    for (const spy of spies) spy.mockRestore();
    process.argv = originalArgv;
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    for (const name of Object.keys({ JSII_SILENCE_SUPPORT_WARNING: '1', ...env })) {
      if (originalEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalEnv[name];
      }
    }
  }
}

function clusterEmitter(): NodeJS.EventEmitter {
  return (cluster as any).default ?? cluster;
}

/**
 * A `yargs` mock factory that forwards everything to the actual `yargs`, but remembers the result of `parse()` so that
 * `runCli` can wait for the (asynchronous) command handler to finish. The CLI does not expose that otherwise, and what
 * it does is not changed.
 *
 * Usage: `jest.mock('yargs', () => mockYargsToTrackParse());`
 */
export function mockYargsToTrackParse() {
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
        return (...args: unknown[]) => {
          let result;
          try {
            result = value.apply(target, args);
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
