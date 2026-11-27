import * as fs from 'node:fs';
import * as path from 'node:path';
import { SPEC_FILE_NAME_COMPRESSED } from '@jsii/spec';

import { makeCliProject, mockYargsToTrackParse, runCli, runCliWithEnv } from './cli-helpers';

const USER_TSCONFIG = {
  compilerOptions: {
    alwaysStrict: true,
    declaration: true,
    esModuleInterop: true,
    lib: ['es2023'],
    module: 'node16',
    moduleResolution: 'node16',
    noEmitOnError: true,
    skipLibCheck: true,
    strict: true,
    target: 'es2023',
  },
  include: ['**/*.ts'],
  exclude: ['node_modules'],
};

jest.setTimeout(30_000);

jest.mock('yargs', () => mockYargsToTrackParse());

const projects = new Array<string>();
const project = (...args: Parameters<typeof makeCliProject>) => {
  const dir = makeCliProject(...args);
  projects.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of projects.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe('jsii --help', () => {
  test('lists the commands', async () => {
    const result = await runCli(project(), '--help');

    expect(result.exitCode).toBe(0);
    for (const command of ['compile [PROJECT_ROOT]', 'validate-tsconfig [TSCONFIG]', 'rules [RULE_SET]']) {
      expect(result.stdout).toContain(command);
    }
  });

  test('lists the options of the compile command, with their aliases', async () => {
    const result = await runCli(project(), '--help');

    for (const option of [
      '-w, --watch',
      '-r, --project-references',
      '--fail-on-warnings, --Werr',
      '--silence-warnings, --Wno',
      '--strip-deprecated',
      '--add-deprecation-warnings',
      '--compress-assembly',
      '--generate-tsconfig',
      '-c, --tsconfig',
      '--validate-tsconfig',
      '-v, --verbose',
    ]) {
      expect(result.stdout).toContain(option);
    }
  });

  test('does not list the option that no longer has any effect', async () => {
    const result = await runCli(project(), '--help');

    expect(result.stdout).not.toContain('fix-peer-dependencies');
  });

  test('does not compile anything', async () => {
    const dir = project();

    await runCli(dir, '--help');

    expect(fs.existsSync(path.join(dir, '.jsii'))).toBe(false);
  });
});

describe('aliases of the options', () => {
  test('--Werr is --fail-on-warnings', async () => {
    const result = await runCli(project({ 'README.md': null }), '--Werr');

    expect(result.exitCode).toBe(1);
  });

  test('--Wno is --silence-warnings', async () => {
    const result = await runCli(project({ 'README.md': null }), '--Werr', '--Wno', 'missing-readme');

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('(+1 silenced)');
  });

  test('--silence-warnings accepts several warnings at once', async () => {
    const result = await runCli(
      project({ 'README.md': null }, { description: undefined }),
      '--Werr',
      '--silence-warnings',
      'missing-readme',
      'JSII0001',
      'JSII0002',
    );

    expect(result.exitCode).toBeUndefined();
  });

  test('-c is --tsconfig', async () => {
    const dir = project({ 'tsconfig.dev.json': JSON.stringify(USER_TSCONFIG) });

    const result = await runCli(dir, '-c', 'tsconfig.dev.json');

    expect(result.exitCode).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'tsconfig.json'))).toBe(false);
  });

  test('-r is --project-references', async () => {
    const dir = project();

    await runCli(dir, '-r');

    expect(JSON.parse(fs.readFileSync(path.join(dir, 'tsconfig.json'), 'utf-8')).compilerOptions.composite).toBe(true);
  });

  test('--fix-peer-dependencies is accepted, and has no effect', async () => {
    const result = await runCli(project(), '--fix-peer-dependencies');

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('✨ Successful');
  });
});

describe('options set with JSII_ environment variables', () => {
  test('JSII_FAIL_ON_WARNINGS is --fail-on-warnings', async () => {
    const result = await runCliWithEnv({ JSII_FAIL_ON_WARNINGS: 'true' }, project({ 'README.md': null }));

    expect(result.exitCode).toBe(1);
  });

  test('JSII_COMPRESS_ASSEMBLY is --compress-assembly', async () => {
    const dir = project();

    const result = await runCliWithEnv({ JSII_COMPRESS_ASSEMBLY: 'true' }, dir);

    expect(result.exitCode).toBeUndefined();
    expect(fs.existsSync(path.join(dir, SPEC_FILE_NAME_COMPRESSED))).toBe(true);
  });

  test('JSII_GENERATE_TSCONFIG is --generate-tsconfig', async () => {
    const dir = project();

    await runCliWithEnv({ JSII_GENERATE_TSCONFIG: 'tsconfig.env.json' }, dir);

    expect(fs.existsSync(path.join(dir, 'tsconfig.env.json'))).toBe(true);
  });

  test('JSII_VALIDATE_TSCONFIG is --validate-tsconfig', async () => {
    const dir = project({
      'tsconfig.dev.json': JSON.stringify({
        ...USER_TSCONFIG,
        compilerOptions: { ...USER_TSCONFIG.compilerOptions, strict: undefined },
      }),
    });

    const result = await runCliWithEnv({ JSII_VALIDATE_TSCONFIG: 'off' }, dir, '--tsconfig', 'tsconfig.dev.json');

    expect(result.stdout).toContain('JSII4009');
    expect(result.stdout).not.toContain('JSII4000');
  });

  test('an option on the command line wins over the environment', async () => {
    const dir = project({ 'README.md': null });

    const result = await runCliWithEnv({ JSII_FAIL_ON_WARNINGS: 'true' }, dir, '--no-fail-on-warnings');

    expect(result.exitCode).toBeUndefined();
  });
});
