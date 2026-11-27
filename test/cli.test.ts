import * as fs from 'node:fs';
import * as path from 'node:path';
import { SPEC_FILE_NAME, SPEC_FILE_NAME_COMPRESSED } from '@jsii/spec';

import { makeCliProject, mockYargsToTrackParse, runCli } from './cli-helpers';

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

describe('jsii compile', () => {
  test('compiles the project in the current directory by default', async () => {
    const dir = project();

    const result = await runCli(dir);

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('✨ Successful');
    expect(fs.existsSync(path.join(dir, SPEC_FILE_NAME))).toBe(true);
  });

  test('"compile" is the default command', async () => {
    const dir = project();

    const result = await runCli(dir, 'compile');

    expect(result.exitCode).toBeUndefined();
    expect(fs.existsSync(path.join(dir, SPEC_FILE_NAME))).toBe(true);
  });

  test('compiles the project at PROJECT_ROOT', async () => {
    const dir = project();

    const result = await runCli(path.dirname(dir), dir);

    expect(result.exitCode).toBeUndefined();
    expect(fs.existsSync(path.join(dir, SPEC_FILE_NAME))).toBe(true);
  });

  test('fails with exit code 1 when compilation fails', async () => {
    const dir = project({ 'index.ts': 'export class Klass extends Missing {}' });

    const result = await runCli(dir);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Cannot find name 'Missing'");
    expect(result.stdout).toContain('❌ Failed with errors');
  });

  test('reports diagnostics from the project info', async () => {
    const dir = project({}, { peerDependencies: { 'does-not-matter': '*' }, dependencies: {} });

    const result = await runCli(dir);

    // The peer dependency cannot be resolved, which is reported as an error
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('Unable to locate jsii assembly for "does-not-matter"');
  });

  test('reports a JsiiError without a stack trace and with exit code -1', async () => {
    const dir = project({}, { license: 'Not an SPDX licence ID' });

    const result = await runCli(dir);

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('Invalid license identifier "Not an SPDX licence ID"');
    expect(result.stderr).not.toContain('at Object');
  });

  describe('--fail-on-warnings', () => {
    test('treats warnings as errors', async () => {
      const dir = project({ 'README.md': null });

      const result = await runCli(dir, '--fail-on-warnings');

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('There is no "README.md" file');
    });

    test('is not enabled by default', async () => {
      const dir = project({ 'README.md': null });

      const result = await runCli(dir);

      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toContain('✨ Successful with warnings');
    });
  });

  describe('--silence-warnings', () => {
    test.each([
      ['a JSII code', 'JSII3'],
      ['a number', '3'],
      ['a diagnostic name', 'missing-readme'],
      ['a diagnostic category', 'metadata'],
    ])('silences a warning given as %s', async (_description, silenced) => {
      const dir = project({ 'README.md': null });

      const result = await runCli(dir, '--fail-on-warnings', '--silence-warnings', silenced);

      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toContain('(+1 silenced)');
    });

    // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2960
    test('rejects an unknown warning (reporting a stack trace)', async () => {
      const dir = project();

      const result = await runCli(dir, '--silence-warnings', 'not-a-warning');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown warning "not-a-warning"');
      expect(result.stderr).toMatch(/\n\s+at parseWarningCodes/);
    });
  });

  test('applies the diagnostics categories configured in package.json', async () => {
    const dir = project(
      { 'README.md': null },
      { jsii: { targets: {}, diagnostics: { 'metadata/missing-readme': 'error' } } },
    );

    const result = await runCli(dir);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('There is no "README.md" file');
  });

  describe('--compress-assembly', () => {
    test('emits a compressed assembly', async () => {
      const dir = project();

      await runCli(dir, '--compress-assembly');

      expect(fs.existsSync(path.join(dir, SPEC_FILE_NAME_COMPRESSED))).toBe(true);
    });

    test('is not enabled by default', async () => {
      const dir = project();

      await runCli(dir);

      expect(fs.existsSync(path.join(dir, SPEC_FILE_NAME_COMPRESSED))).toBe(false);
    });
  });

  describe('--add-deprecation-warnings', () => {
    const source = "export class Klass {\n  /** @deprecated use something else */\n  public old() { return 'old'; }\n}";

    test('emits the deprecation warnings file', async () => {
      const dir = project(
        { 'index.ts': source },
        { exports: { '.': './index.js', './.warnings.jsii.js': './.warnings.jsii.js' } },
      );

      const result = await runCli(dir, '--add-deprecation-warnings');

      expect(result.exitCode).toBeUndefined();
      expect(fs.existsSync(path.join(dir, '.warnings.jsii.js'))).toBe(true);
    });

    test('is not enabled by default', async () => {
      const dir = project({ 'index.ts': source });

      await runCli(dir);

      expect(fs.existsSync(path.join(dir, '.warnings.jsii.js'))).toBe(false);
    });
  });

  describe('--strip-deprecated', () => {
    const source =
      "export class Klass {\n  /** @deprecated use something else */\n  public old() { return 'old'; }\n  public current() { return 'current'; }\n}";
    const methodsOf = (dir: string) =>
      (
        JSON.parse(fs.readFileSync(path.join(dir, SPEC_FILE_NAME), 'utf-8')).types['cli-test-package.Klass'].methods ??
        []
      ).map((method: { name: string }) => method.name);

    test('removes deprecated members from the assembly', async () => {
      const dir = project({ 'index.ts': source });

      const result = await runCli(dir, '--strip-deprecated');

      expect(result.exitCode).toBeUndefined();
      expect(methodsOf(dir)).toEqual(['current']);
    });

    test('only removes the members that are listed in the allow list file', async () => {
      const dir = project({ 'index.ts': source, 'allowlist.txt': 'cli-test-package.Klass#unrelated\n' });

      const result = await runCli(dir, '--strip-deprecated', 'allowlist.txt');

      expect(result.exitCode).toBeUndefined();
      expect(methodsOf(dir).sort()).toEqual(['current', 'old']);
    });
  });

  describe('TypeScript configuration', () => {
    test('--generate-tsconfig writes the configuration to the given file', async () => {
      const dir = project();

      const result = await runCli(dir, '--generate-tsconfig', 'tsconfig.jsii.json');

      expect(result.exitCode).toBeUndefined();
      expect(fs.existsSync(path.join(dir, 'tsconfig.jsii.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'tsconfig.json'))).toBe(false);
    });

    test('--project-references enables project references', async () => {
      const dir = project();

      const result = await runCli(dir, '--project-references');

      expect(result.exitCode).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'tsconfig.json'), 'utf-8')).compilerOptions.composite).toBe(
        true,
      );
    });

    test('--tsconfig uses the given configuration', async () => {
      const dir = project({ 'tsconfig.dev.json': JSON.stringify(userTsconfig()) });

      const result = await runCli(dir, '--tsconfig', 'tsconfig.dev.json');

      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toContain('✨ Successful');
      expect(fs.existsSync(path.join(dir, 'tsconfig.json'))).toBe(false);
    });

    test('jsii.tsconfig in package.json selects the configuration', async () => {
      const dir = project(
        { 'tsconfig.dev.json': JSON.stringify(userTsconfig()) },
        { jsii: { targets: {}, tsconfig: 'tsconfig.dev.json' } },
      );

      const result = await runCli(dir);

      expect(result.exitCode).toBeUndefined();
      expect(fs.existsSync(path.join(dir, 'tsconfig.json'))).toBe(false);
    });

    test('--tsconfig and --generate-tsconfig are mutually exclusive', async () => {
      const dir = project();

      const result = await runCli(dir, '--tsconfig', 'a.json', '--generate-tsconfig', 'b.json');

      expect(result.exitCode).not.toBeUndefined();
      expect(result.stderr).toContain('mutually exclusive');
    });

    test('--validate-tsconfig selects the rule set', async () => {
      const dir = project({ 'tsconfig.dev.json': JSON.stringify(userTsconfig({ strict: false })) });

      const strict = await runCli(dir, '--tsconfig', 'tsconfig.dev.json', '--validate-tsconfig', 'strict');
      const off = await runCli(dir, '--tsconfig', 'tsconfig.dev.json', '--validate-tsconfig', 'off');

      expect(strict.exitCode).toBe(-1);
      expect(strict.stderr).toContain('Failed validation of tsconfig "compilerOptions" in "tsconfig.dev.json"');
      expect(strict.stdout).toContain('are not passing validation against rule set "strict"');
      expect(off.exitCode).toBeUndefined();
    });

    test('jsii.validateTsconfig in package.json selects the rule set', async () => {
      const dir = project(
        { 'tsconfig.dev.json': JSON.stringify(userTsconfig({ strict: false })) },
        { jsii: { targets: {}, tsconfig: 'tsconfig.dev.json', validateTsconfig: 'off' } },
      );

      const result = await runCli(dir);

      expect(result.exitCode).toBeUndefined();
    });
  });

  describe('--verbose', () => {
    // Diagnostics are shown by their category: warnings by default, suggestions (such as the missing description)
    // only when the output is at its most verbose.
    // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/3002
    // Showing a suggestion makes the compiler crash.
    test('shows suggestions only at the highest levels of verbosity, where they make the CLI crash', async () => {
      const quiet = await runCli(project({}, { description: undefined }));
      const verbose = await runCli(project({}, { description: undefined }), '-vvv');

      expect(quiet.exitCode).toBeUndefined();
      expect(quiet.stdout).not.toContain('JSII1');
      expect(verbose.exitCode).toBe(1);
      expect(verbose.stderr).toContain('Debug Failure. Should never get an Info diagnostic on the command line.');
    });

    test('shows messages (such as the use of unsupported syntax) from the second level of verbosity', async () => {
      const dir = project({
        'index.ts': 'export class Klass { public static value = 0; static { Klass.value = 1; } }',
      });

      const info = await runCli(dir, '-v');
      const debug = await runCli(dir, '-vv');

      expect(info.stdout).not.toContain('JSII9998');
      expect(debug.stdout).toContain('JSII9998');
    });

    test.each([[['-v']], [['-vv']], [['-vvvv']]])('is accepted as %j', async (flags) => {
      const dir = project();

      const result = await runCli(dir, ...flags);

      expect(result.exitCode).toBeUndefined();
    });
  });
});

describe('@jsii suppress', () => {
  const source = (directive: string) => ({
    'index.ts': `export class Foo {
      ${directive}
      public foo(): void {}
    }`,
  });

  test('hides the warning it names', async () => {
    const result = await runCli(project(source('/** @jsii suppress JSII5019 */')));

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).not.toContain('JSII5019');
  });

  test('ignores an identifier that is not a diagnostic, and shows the warning', async () => {
    const result = await runCli(project(source('/** @jsii suppress not-a-diagnostic */')));

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('JSII5019');
  });
});

describe('jsii rules', () => {
  test('prints the rules of every rule set by default', async () => {
    const result = await runCli(process.cwd(), 'rules');

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('strict');
    expect(result.stdout).toContain('generated');
    expect(result.stdout).toContain('minimal');
    expect(result.stdout).toContain('─'.repeat(72));
  });

  test('prints the rules of a single rule set', async () => {
    const result = await runCli(process.cwd(), 'rules', 'strict');

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('strict');
    expect(result.stdout).not.toContain('─'.repeat(72));
  });
});

describe('jsii validate-tsconfig', () => {
  test('reports a valid configuration', async () => {
    const dir = project({ 'tsconfig.json': JSON.stringify(userTsconfig()) });

    const result = await runCli(dir, 'validate-tsconfig');

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('✨ "tsconfig.json" is valid against rule set "strict"');
  });

  test('reports an invalid configuration', async () => {
    const dir = project({ 'tsconfig.json': JSON.stringify(userTsconfig({ strict: false })) });

    const result = await runCli(dir, 'validate-tsconfig');

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('are not passing validation against rule set "strict"');
  });

  test('--rule-set selects the rule set, and "off" disables validation', async () => {
    const dir = project({ 'tsconfig.json': JSON.stringify(userTsconfig({ strict: false })) });

    const result = await runCli(dir, 'validate-tsconfig', '--rule-set', 'off');

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('Validation of typescript config "tsconfig.json" is disabled');
  });

  test('uses the configuration and rule set from package.json', async () => {
    const dir = project(
      { 'custom.json': JSON.stringify(userTsconfig()) },
      { jsii: { targets: {}, tsconfig: 'custom.json', validateTsconfig: 'strict' } },
    );

    const result = await runCli(dir, 'validate-tsconfig');

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('"custom.json" is valid against rule set "strict"');
  });

  test('fails when the configuration cannot be read', async () => {
    const dir = project();

    const result = await runCli(dir, 'validate-tsconfig', 'missing.json');

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('Failed to read tsconfig at');
  });

  // https://github.com/aws/jsii-compiler/issues/2987
  test.each([
    [{ target: 'es5' }, 'target: Expected value not to be "es5", got: "es5"'],
    [{ module: 'amd' }, 'module: Expected value not to be one of ["amd","umd","systemjs","none"], got: "amd"'],
    [{ noEmit: true }, 'noEmit: Expected value not to be true, got: true'],
    [{ downlevelIteration: true }, 'downlevelIteration: Expected value to be absent, got true'],
  ])('describes the violation of %j the way the rule reads', async (overrides, violation) => {
    const dir = project({ 'tsconfig.json': JSON.stringify(userTsconfig(overrides)) });

    const result = await runCli(dir, 'validate-tsconfig');

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(violation);
  });

  test('works without a package.json', async () => {
    const dir = project({ 'package.json': null, 'tsconfig.json': JSON.stringify(userTsconfig()) });

    const result = await runCli(dir, 'validate-tsconfig');

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('is valid');
  });
});

describe('jsii --version', () => {
  test('prints the jsii and typescript versions', async () => {
    const result = await runCli(process.cwd(), '--version');

    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+ \(build .+\), typescript \d+\.\d+\.\d+/);
  });
});

// These tests document current behavior that looks wrong. Each one references the issue that describes it.
describe('current behavior that is reported as an issue', () => {
  const run = (dir: string, ...args: string[]) => runCli(dir, ...args);

  // https://github.com/aws/jsii-compiler/issues/2979
  test('diagnostic codes below 1000 are printed without zero padding', async () => {
    const result = await run(project({ 'README.md': null }));

    expect(result.stdout).toContain('warning JSII3: There is no "README.md" file.');
    expect(result.stdout).not.toContain('JSII0003');
  });

  // https://github.com/aws/jsii-compiler/issues/2980
  test('the assembly is written although compilation errors prevented it from being created', async () => {
    const dir = project({ 'index.ts': "export class Klass {}\nexport const n: number = 'a';" });

    const result = await run(dir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Compilation errors prevented the JSII assembly from being created');
    expect(fs.existsSync(path.join(dir, SPEC_FILE_NAME))).toBe(true);
  });

  // https://github.com/aws/jsii-compiler/issues/2981
  test('--fail-on-warnings with only warnings reports errors', async () => {
    const result = await run(project({ 'README.md': null }), '--fail-on-warnings');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Type model errors prevented the JSII assembly from being created');
    expect(result.stdout).toContain('❌ Failed with errors');
    expect(result.stdout).toContain('Errors: 0 | Warnings: 1');
  });

  // https://github.com/aws/jsii-compiler/issues/2982
  test('errors from parsing the tsconfig are dropped, and the entry point is reported as missing', async () => {
    const { include, exclude, ...config } = userTsconfig({ outDir: 'lib', rootDir: 'lib' });
    const dir = project(
      { 'tsconfig.json': JSON.stringify(config), 'lib/index.ts': 'export class Klass {}', 'index.ts': null },
      { main: 'lib/index.js', types: 'lib/index.d.ts' },
    );

    const result = await run(dir, '--tsconfig', 'tsconfig.json');

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('JSII4: Could not find "main" file');
    expect(result.stdout).not.toContain('TS18003');
  });

  // https://github.com/aws/jsii-compiler/issues/2983
  test('JSII4009 is printed, but it is not counted as a warning', async () => {
    const dir = project({ 'tsconfig.dev.json': JSON.stringify(userTsconfig()) });

    const result = await run(
      dir,
      '--tsconfig',
      'tsconfig.dev.json',
      '--validate-tsconfig',
      'off',
      '--fail-on-warnings',
    );

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('warning JSII4009');
    expect(result.stdout).toContain('Errors: 0 | Warnings: 0');
  });

  // https://github.com/aws/jsii-compiler/issues/2984
  test('a missing package.json prints the help and the raw error', async () => {
    const result = await run(project({ 'package.json': null }));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('jsii compile [PROJECT_ROOT]');
    expect(result.stderr).toContain('ENOENT: no such file or directory');
  });

  describe('violations of the tsconfig validation', () => {
    const violations = async (overrides: Record<string, unknown>) => {
      const dir = project({ 'tsconfig.dev.json': JSON.stringify(userTsconfig(overrides)) });
      return (await run(dir, 'validate-tsconfig', 'tsconfig.dev.json')).stdout;
    };

    // https://github.com/aws/jsii-compiler/issues/2987
    test('print the expected value of a rule that forbids a value as the one that was expected', async () => {
      expect(await violations({ target: 'es5' })).toContain('target: Expected value "es5", got: "es5"');
    });

    // https://github.com/aws/jsii-compiler/issues/2987
    test('print "to be present" for an option that must not be present', async () => {
      expect(await violations({ downlevelIteration: true })).toContain(
        'downlevelIteration: Expected value to be present, got true',
      );
    });

    // https://github.com/aws/jsii-compiler/issues/2992
    test('reject "paths" because of an option that TypeScript adds', async () => {
      expect(await violations({ paths: { '@x/*': ['lib/*'] } })).toContain(
        'pathsBasePath: Unexpected field, got: pathsBasePath',
      );
    });
  });

  describe('a tsconfig in a subdirectory with "extends"', () => {
    const files = () => ({
      'sub/tsconfig.json': JSON.stringify({ extends: './base.json', ...userTsconfig() }),
      'sub/base.json': JSON.stringify({ compilerOptions: { baseUrl: '.' } }),
    });

    // https://github.com/aws/jsii-compiler/issues/2991
    test('is resolved against the project root when compiling, so the base is not read', async () => {
      const result = await run(project(files()), '--tsconfig', 'sub/tsconfig.json', '--validate-tsconfig', 'strict');

      expect(result.exitCode).toBeUndefined();
    });

    // https://github.com/aws/jsii-compiler/issues/2991
    test('is resolved against its own directory by validate-tsconfig, so the base is read', async () => {
      const result = await run(project(files()), 'validate-tsconfig', 'sub/tsconfig.json');

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('baseUrl: Expected value to be present');
    });

    // https://github.com/aws/jsii-compiler/issues/2991
    test('passes the validation when the base does not exist', async () => {
      const dir = project({ 'tsconfig.json': JSON.stringify({ extends: './nope.json', ...userTsconfig() }) });

      const result = await run(dir, '--tsconfig', 'tsconfig.json', '--validate-tsconfig', 'strict');

      expect(result.exitCode).toBeUndefined();
    });
  });
});

/** A tsconfig that is valid for the "strict" rule set, with optional overrides to compiler options. */
function userTsconfig(overrides: Record<string, unknown> = {}) {
  return {
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
      ...overrides,
    },
    include: ['**/*.ts'],
    exclude: ['node_modules'],
  };
}
