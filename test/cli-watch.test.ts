import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { makeCliProject } from './cli-helpers';

jest.setTimeout(120_000);

// Run the CLI in this one node process. The `tsx` command starts the CLI in a second process,
// which a signal sent to the command does not reach.
const TSX_IMPORT = pathToFileURL(path.join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const MAIN = path.join(__dirname, '..', 'src', 'main.ts');

async function eventually(condition: () => boolean, what: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('jsii --watch', () => {
  let dir: string;
  let child: ReturnType<typeof spawn> | undefined;
  let output = '';

  beforeEach(() => {
    dir = makeCliProject();
    output = '';
  });

  afterEach(async () => {
    // Wait for the watcher to stop, so it does not write to the directory while it is removed.
    if (child != null && child.exitCode == null && child.signalCode == null) {
      const exited = new Promise((resolve) => child!.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    if (child?.pid != null) {
      // No watcher process is left behind: signal 0 only checks that the process exists.
      expect(() => process.kill(child!.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    }
    child = undefined;
    // Second safety net: retry in case a late write is still finishing.
    fs.rmSync(dir, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
  });

  function start(flag: string) {
    child = spawn(process.execPath, ['--import', TSX_IMPORT, MAIN, flag], {
      cwd: dir,
      env: { ...process.env, JSII_SILENCE_SUPPORT_WARNING: '1', NO_COLOR: '1' },
    });
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
  }

  const assembly = () => JSON.parse(fs.readFileSync(path.join(dir, '.jsii'), 'utf-8'));
  const hasType = (name: string) => fs.existsSync(path.join(dir, '.jsii')) && name in (assembly().types ?? {});

  test.each(['--watch', '-w'])('%s compiles, keeps running, and recompiles when a file changes', async (flag) => {
    start(flag);

    await eventually(() => hasType('cli-test-package.Klass'), 'the first compilation');
    expect(child?.exitCode).toBeNull();

    fs.writeFileSync(path.join(dir, 'index.ts'), 'export class Klass {}\nexport class Added {}\n');

    await eventually(() => hasType('cli-test-package.Added'), 'the recompilation');
    expect(child?.exitCode).toBeNull();
  });

  test('reports a compilation error and keeps watching', async () => {
    start('--watch');
    await eventually(() => hasType('cli-test-package.Klass'), 'the first compilation');

    fs.writeFileSync(path.join(dir, 'index.ts'), 'export class Klass extends Missing {}\n');
    await eventually(() => output.includes("Cannot find name 'Missing'"), 'the error to be reported');
    expect(child?.exitCode).toBeNull();

    fs.writeFileSync(path.join(dir, 'index.ts'), 'export class Klass {}\nexport class Fixed {}\n');
    await eventually(() => hasType('cli-test-package.Fixed'), 'the compilation after the fix');
  });
});
