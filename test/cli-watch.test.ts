import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { makeCliProject } from './cli-helpers';

jest.setTimeout(120_000);

const TSX = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');
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

// @TODO(ts7): the TypeScript 7 compiler does not support --watch yet (aws/jsii-compiler#3149)
describe.skip('jsii --watch', () => {
  let dir: string;
  let child: ReturnType<typeof spawn> | undefined;
  let output = '';

  beforeEach(() => {
    dir = makeCliProject();
    output = '';
  });

  afterEach(() => {
    child?.kill('SIGKILL');
    child = undefined;
    fs.rmSync(dir, { force: true, recursive: true });
  });

  function start(flag: string) {
    child = spawn(TSX, [MAIN, flag], {
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
