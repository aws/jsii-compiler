import { mkdirSync, existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadAssemblyFromPath, SPEC_FILE_NAME, SPEC_FILE_NAME_COMPRESSED } from '@jsii/spec';
import * as ts from 'typescript';
import { compile, Lock } from './fixtures';
import { Compiler } from '../src/compiler';
import { ProjectInfo } from '../src/project-info';
import { TypeScriptConfigValidationRuleSet } from '../src/tsconfig';
import { TypeScriptConfigValidator } from '../src/tsconfig/tsconfig-validator';

// This is necessary to be able to jest.spyOn to functions in the 'ts' module. Replace the read-only
// object descriptors with a plain object.
jest.mock('typescript', () => ({ ...jest.requireActual('typescript') }));

beforeEach(() => {
  jest.restoreAllMocks();
});

describe(Compiler, () => {
  describe('generated tsconfig', () => {
    test('default is tsconfig.json', () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'jsii-compiler-watch-mode-'));

      const compiler = new Compiler({
        projectInfo: _makeProjectInfo(sourceDir, 'index.d.ts'),
      });

      compiler.emit();

      expect(JSON.parse(readFileSync(join(sourceDir, 'tsconfig.json'), 'utf-8'))).toEqual(expectedTypeScriptConfig());
    });

    test('file name can be customized', () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'jsii-compiler-watch-mode-'));

      const compiler = new Compiler({
        projectInfo: _makeProjectInfo(sourceDir, 'index.d.ts'),
        generateTypeScriptConfig: 'tsconfig.jsii.json',
      });

      compiler.emit();

      expect(JSON.parse(readFileSync(join(sourceDir, 'tsconfig.jsii.json'), 'utf-8'))).toEqual(
        expectedTypeScriptConfig(),
      );
    });

    test('generated tsconfig passed validation', () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'jsii-compiler-watch-mode-'));

      const compiler = new Compiler({
        projectInfo: _makeProjectInfo(sourceDir, 'index.d.ts'),
      });

      compiler.emit();

      // read generated config
      const tsconfig = JSON.parse(readFileSync(join(sourceDir, 'tsconfig.json'), 'utf-8'));

      // set up the tsconfig validator with rules for the generated file
      const validator = new TypeScriptConfigValidator(TypeScriptConfigValidationRuleSet.GENERATED);

      expect(() => validator.validate(tsconfig)).not.toThrow();
    });

    test('"watch" mode', async () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'jsii-compiler-watch-mode-'));

      try {
        writeFileSync(join(sourceDir, 'index.ts'), 'export class MarkerA {}');
        // Intentionally using lower case name - it should be case-insensitive
        writeFileSync(join(sourceDir, 'readme.md'), '# Test Package');

        const compiler = new Compiler({
          projectInfo: _makeProjectInfo(sourceDir, 'index.d.ts'),
          failOnWarnings: true,
          projectReferences: false,
        });

        let firstCompilation = true;
        let onWatchClosed: () => void;
        let onWatchFailed: (err: unknown) => void;
        const watchClosed = new Promise<void>((ok, ko) => {
          onWatchClosed = ok;
          onWatchFailed = ko;
        });
        const watch = await compiler.watch({
          nonBlocking: true,
          // Ignore diagnostics reporting (not to pollute test console output)
          reportDiagnostics: () => null,
          // Ignore watch status reporting (not to pollute test console output)
          reportWatchStatus: () => null,
          // Verify everything goes according to plan
          compilationComplete: (emitResult) => {
            try {
              expect(emitResult.emitSkipped).toBeFalsy();
              const output = JSON.stringify(loadAssemblyFromPath(sourceDir));
              if (firstCompilation) {
                firstCompilation = false;
                expect(output).toContain('"MarkerA"');
                setImmediate(() => writeFileSync(join(sourceDir, 'index.ts'), 'export class MarkerB {}'));
                return;
              }
              expect(output).toContain('"MarkerB"');
              watch.close();
              // Tell the test suite we're done here!
              onWatchClosed();
            } catch (e) {
              watch.close();
              onWatchFailed(e);
            }
          },
        });
        await watchClosed;
      } finally {
        rmSync(sourceDir, { force: true, recursive: true });
      }
    }, 25_000);

    test('rootDir is added to assembly', () => {
      const outDir = 'jsii-outdir';
      const rootDir = 'jsii-rootdir';
      const sourceDir = mkdtempSync(join(tmpdir(), 'jsii-tmpdir'));
      mkdirSync(join(sourceDir, rootDir), { recursive: true });

      try {
        writeFileSync(join(sourceDir, rootDir, 'index.ts'), 'export class MarkerA {}');
        // Intentionally using lower case name - it should be case-insensitive
        writeFileSync(join(sourceDir, rootDir, 'readme.md'), '# Test Package');

        const compiler = new Compiler({
          projectInfo: {
            ..._makeProjectInfo(sourceDir, join(outDir, 'index.d.ts')),
            tsc: {
              outDir,
              rootDir,
            },
          },
          failOnWarnings: true,
          projectReferences: false,
        });

        compiler.emit();

        const assembly = loadAssemblyFromPath(sourceDir);
        expect(assembly.metadata).toEqual(
          expect.objectContaining({
            tscRootDir: rootDir,
          }),
        );
      } finally {
        rmSync(sourceDir, { force: true, recursive: true });
      }
    });

    test('emits declaration map when feature is enabled', () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'jsii-tmpdir'));

      try {
        writeFileSync(join(sourceDir, 'index.ts'), 'export class MarkerA {}');

        const compiler = new Compiler({
          projectInfo: {
            ..._makeProjectInfo(sourceDir, 'index.d.ts'),
            tsc: {
              declarationMap: true,
            },
          },
          generateTypeScriptConfig: 'tsconfig.jsii.json',
        });

        compiler.emit();

        expect(() => {
          readFileSync(join(sourceDir, 'index.d.ts.map'), 'utf-8');
        }).not.toThrow();
      } finally {
        rmSync(sourceDir, { force: true, recursive: true });
      }
    });

    describe('project references', () => {
      let lock: Lock | undefined;

      beforeAll(async () => {
        lock = await Lock.acquire();
      }, 120_000);

      afterAll(async () => {
        await lock?.release();
        lock = undefined;
      }, 120_000);

      test('can resolve project references', async () => {
        const sourceDir = mkdtempSync(join(tmpdir(), 'jsii-compiler-project-refs'));

        // link the composite package
        const fixture = '@fixtures/jsii-composite';
        const fixtureLocation = compile(lock!, fixture, false);
        const linkLocation = join(sourceDir, 'node_modules', fixture);
        mkdirSync(dirname(linkLocation), { recursive: true });
        symlinkSync(fixtureLocation, linkLocation, 'dir');

        // Add some files to the parent project
        writeFileSync(join(sourceDir, 'index.ts'), 'export class MarkerA {}');
        writeFileSync(join(sourceDir, 'README.md'), '# Test Package');

        const compiler = new Compiler({
          projectInfo: {
            ..._makeProjectInfo(sourceDir, 'index.d.ts'),
            packageJson: {
              devDependencies: {
                '@fixtures/jsii-composite': '*',
              },
            },
          },
          projectReferences: true,
        });

        compiler.emit();

        expect(JSON.parse(readFileSync(join(sourceDir, 'tsconfig.json'), 'utf-8'))).toMatchObject({
          compilerOptions: {
            composite: true,
          },
          references: [
            {
              path: expect.stringMatching('fixtures/@fixtures/jsii-composite'),
            },
          ],
        });
      }, 120_000);
    });
  });

  describe('user-provided tsconfig', () => {
    let sourceDir: string;
    const tsconfigPath = 'tsconfig.dev.json';
    beforeEach(() => {
      sourceDir = mkdtempSync(join(tmpdir(), 'jsii-compiler-user-tsconfig-'));
    });

    afterEach(() => {
      rmSync(sourceDir, { force: true, recursive: true });
    });

    test('will use user-provided config', () => {
      writeFileSync(join(sourceDir, tsconfigPath), JSON.stringify(tsconfigForNode18Strict(), null, 2));

      writeFileSync(join(sourceDir, 'index.ts'), 'export class MarkerA {}');
      writeFileSync(join(sourceDir, 'README.md'), '# Test Package');
      const compiler = new Compiler({
        projectInfo: _makeProjectInfo(sourceDir, 'index.d.ts'),
        typeScriptConfig: tsconfigPath,
      });

      const result = compiler.emit();
      expect(result.diagnostics).toEqual([]);
      expect(result.emitSkipped).toBe(false);
    });

    test('use user-provided config uses include and exclude', () => {
      mkdirSync(join(sourceDir, 'sub'));
      writeFileSync(
        join(sourceDir, tsconfigPath),
        JSON.stringify(
          {
            compilerOptions: {
              lib: ['es2022'],
              module: 'node16',
              target: 'es2022',
              noImplicitAny: true,
            },
            include: ['**/*.ts'],
            exclude: ['sub/**'],
          },
          null,
          2,
        ),
      );

      writeFileSync(join(sourceDir, 'index.ts'), 'export class MarkerA {}');
      writeFileSync(join(sourceDir, 'README.md'), '# Test Package');

      // file with an implicit any that fails against the local config if not excluded
      writeFileSync(join(sourceDir, 'sub', 'index.ts'), 'export class MarkerB { constructor(public foobar) {} }');

      const compiler = new Compiler({
        projectInfo: _makeProjectInfo(sourceDir, 'index.d.ts'),
        typeScriptConfig: tsconfigPath,
      });

      const result = compiler.emit();
      expect(result.diagnostics).toEqual([]);
      expect(result.emitSkipped).toBe(false);
    });

    test('respect "lib" setting from user-provided config', () => {
      const tsconfig = tsconfigForNode18Strict();
      tsconfig.compilerOptions.lib = ['Decorators.Legacy']; // Something very nonstandard
      writeFileSync(join(sourceDir, tsconfigPath), JSON.stringify(tsconfig, null, 2));

      const createIncrementalProgram = jest.spyOn(ts, 'createIncrementalProgram');

      const compiler = new Compiler({
        projectInfo: _makeProjectInfo(sourceDir, 'index.d.ts'),
        typeScriptConfig: tsconfigPath,
      });
      compiler.emit();

      expect(createIncrementalProgram).toHaveBeenCalledWith(
        expect.objectContaining({
          rootNames: expect.arrayContaining([expect.stringContaining('lib.decorators.legacy.d.ts')]),
        }),
      );
    });

    test('missing "lib" setting is based on compilation target', () => {
      const tsconfig = tsconfigForNode18Strict();
      tsconfig.compilerOptions.target = 'es6';
      delete tsconfig.compilerOptions.lib;
      writeFileSync(join(sourceDir, tsconfigPath), JSON.stringify(tsconfig, null, 2));

      const createIncrementalProgram = jest.spyOn(ts, 'createIncrementalProgram');

      const compiler = new Compiler({
        projectInfo: _makeProjectInfo(sourceDir, 'index.d.ts'),
        typeScriptConfig: tsconfigPath,
      });
      compiler.emit();

      expect(createIncrementalProgram).toHaveBeenCalledWith(
        expect.objectContaining({
          rootNames: expect.arrayContaining([expect.stringContaining('lib.es6.d.ts')]),
        }),
      );
    });

    test('"watch" mode', async () => {
      writeFileSync(join(sourceDir, tsconfigPath), JSON.stringify(tsconfigForNode18Strict(), null, 2));

      try {
        writeFileSync(join(sourceDir, 'index.ts'), 'export class MarkerA {}');
        // Intentionally using lower case name - it should be case-insensitive
        writeFileSync(join(sourceDir, 'readme.md'), '# Test Package');

        const compiler = new Compiler({
          projectInfo: _makeProjectInfo(sourceDir, 'index.d.ts'),
          failOnWarnings: true,
          typeScriptConfig: tsconfigPath,
          validateTypeScriptConfig: TypeScriptConfigValidationRuleSet.STRICT,
        });

        let firstCompilation = true;
        let onWatchClosed: () => void;
        let onWatchFailed: (err: unknown) => void;
        const watchClosed = new Promise<void>((ok, ko) => {
          onWatchClosed = ok;
          onWatchFailed = ko;
        });
        const watch = await compiler.watch({
          nonBlocking: true,
          // Ignore diagnostics reporting (not to pollute test console output)
          reportDiagnostics: () => null,
          // Ignore watch status reporting (not to pollute test console output)
          reportWatchStatus: () => null,
          // Verify everything goes according to plan
          compilationComplete: (emitResult) => {
            try {
              expect(emitResult.emitSkipped).toBeFalsy();
              const output = JSON.stringify(loadAssemblyFromPath(sourceDir));
              if (firstCompilation) {
                firstCompilation = false;
                expect(output).toContain('"MarkerA"');
                setImmediate(() => writeFileSync(join(sourceDir, 'index.ts'), 'export class MarkerB {}'));
                return;
              }
              expect(output).toContain('"MarkerB"');
              watch.close();
              // Tell the test suite we're done here!
              onWatchClosed();
            } catch (e) {
              watch.close();
              onWatchFailed(e);
            }
          },
        });
        await watchClosed;
      } finally {
        rmSync(sourceDir, { force: true, recursive: true });
      }
    }, 25_000);
  });

  describe('compressed assembly option', () => {
    test('creates a gzipped assembly file', () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'jsii-tmpdir'));

      try {
        writeFileSync(join(sourceDir, 'index.ts'), 'export class MarkerA {}');

        const compiler = new Compiler({
          projectInfo: _makeProjectInfo(sourceDir, 'index.d.ts'),
          compressAssembly: true,
        });

        compiler.emit();

        expect(existsSync(join(sourceDir, SPEC_FILE_NAME_COMPRESSED))).toBeTruthy();
      } finally {
        rmSync(sourceDir, { force: true, recursive: true });
      }
    });

    test('creates file equivalent to uncompressed file', () => {
      const uncompressedSourceDir = mkdtempSync(join(tmpdir(), 'jsii-tmpdir'));
      const compressedSourceDir = mkdtempSync(join(tmpdir(), 'jsii-tmpdir-2'));

      try {
        const fileContents = 'export class MarkerA {}';
        writeFileSync(join(uncompressedSourceDir, 'index.ts'), fileContents);
        writeFileSync(join(compressedSourceDir, 'index.ts'), fileContents);

        const uncompressedJsiiCompiler = new Compiler({
          projectInfo: _makeProjectInfo(uncompressedSourceDir, 'index.d.ts'),
        });
        const compressedJsiiCompiler = new Compiler({
          projectInfo: _makeProjectInfo(compressedSourceDir, 'index.d.ts'),
          compressAssembly: true,
        });

        uncompressedJsiiCompiler.emit();
        compressedJsiiCompiler.emit();

        // The files we expect are there
        expect(existsSync(join(uncompressedSourceDir, SPEC_FILE_NAME))).toBeTruthy();
        expect(existsSync(join(compressedSourceDir, SPEC_FILE_NAME_COMPRESSED))).toBeTruthy();

        const uncompressedJsii = loadAssemblyFromPath(uncompressedSourceDir);
        const compressedJsii = loadAssemblyFromPath(compressedSourceDir);

        expect(compressedJsii).toEqual(uncompressedJsii);
      } finally {
        rmSync(uncompressedSourceDir, { force: true, recursive: true });
        rmSync(compressedSourceDir, { force: true, recursive: true });
      }
    });
  });
});

function _makeProjectInfo(sourceDir: string, types: string): ProjectInfo {
  return {
    projectRoot: sourceDir,
    description: 'test',
    homepage: 'https://github.com/aws/jsii-compiler',
    packageJson: {},
    types,
    main: types.replace(/(?:\.d)?\.ts(x?)/, '.js$1'),
    name: 'jsii', // That's what package.json would tell if we look up...
    version: '0.0.1',
    jsiiVersionFormat: 'short',
    license: 'Apache-2.0',
    author: { name: 'John Doe', roles: ['author'] },
    repository: { type: 'git', url: 'https://github.com/aws/jsii.git' },
    dependencies: {},
    peerDependencies: {},
    dependencyClosure: [],
    bundleDependencies: {},
    targets: {},
    excludeTypescript: [],
    tsc: {
      // NOTE: these are the default values jsii uses when none are provided in package.json.
      inlineSourceMap: true,
      inlineSources: true,
    },
  };
}

function expectedTypeScriptConfig() {
  return {
    _generated_by_jsii_: 'Generated by jsii - safe to delete, and ideally should be in .gitignore',
    compilerOptions: {
      alwaysStrict: true,
      composite: false,
      declaration: true,
      incremental: true,
      inlineSourceMap: true,
      inlineSources: true,
      lib: ['es2020'],
      module: 'commonjs',
      noEmitOnError: true,
      noFallthroughCasesInSwitch: true,
      noImplicitAny: true,
      noImplicitReturns: true,
      noImplicitThis: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      strict: true,
      strictNullChecks: true,
      strictPropertyInitialization: true,
      stripInternal: false,
      target: 'es2020',
      tsBuildInfoFile: 'tsconfig.tsbuildinfo',
    },
    exclude: ['node_modules'],
    include: [join('**', '*.ts')],
  };
}

/**
 * An example of a user-provided config, based on the popular tsconfig/bases project & adjusted for the strict rule set
 * @see https://github.com/tsconfig/bases/blob/main/bases/node18.json
 */
function tsconfigForNode18Strict() {
  return {
    compilerOptions: {
      lib: ['es2022'] as string[] | undefined,
      module: 'node16',
      target: 'es2022',

      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmitOnError: true,
      moduleResolution: 'node16',
      declaration: true,
    },
    exclude: ['node_modules'],
    include: [join('**', '*.ts')],
  };
}
