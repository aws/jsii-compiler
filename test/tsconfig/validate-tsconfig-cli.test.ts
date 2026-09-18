import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAIN = join(__dirname, '..', '..', 'src', 'main.ts');

describe('validate-tsconfig CLI defaults', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'jsii-validate-tsconfig-cli-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    return spawnSync('npx', ['tsx', MAIN, 'validate-tsconfig', ...args], {
      cwd: workdir,
      encoding: 'utf-8',
    });
  }

  test('reads tsconfig path from package.json jsii.tsconfig', () => {
    writeFileSync(join(workdir, 'package.json'), JSON.stringify({ jsii: { tsconfig: 'custom.json' } }));

    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('custom.json');
  });

  test('reads rule-set from package.json jsii.validateTsconfig', () => {
    writeFileSync(join(workdir, 'package.json'), JSON.stringify({ jsii: { validateTsconfig: 'off' } }));
    writeFileSync(join(workdir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));

    const result = run();
    expect(result.stdout).toMatch(/disabled/i);
    expect(result.status).toBe(0);
  });

  test('explicit CLI args override package.json', () => {
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ jsii: { tsconfig: 'ignored.json', validateTsconfig: 'off' } }),
    );
    writeFileSync(
      join(workdir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'es2023',
          lib: ['es2023'],
          module: 'node16',
          esModuleInterop: true,
          skipLibCheck: true,
          noEmitOnError: true,
          declaration: true,
        },
      }),
    );

    const result = run('tsconfig.json', '--rule-set', 'strict');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('valid');
  });

  test('falls back to tsconfig.json when no package.json exists', () => {
    writeFileSync(
      join(workdir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'es2023',
          lib: ['es2023'],
          module: 'node16',
          esModuleInterop: true,
          skipLibCheck: true,
          noEmitOnError: true,
          declaration: true,
        },
      }),
    );

    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('valid');
  });
});
