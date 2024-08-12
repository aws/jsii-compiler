import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compiler } from '../src/compiler';
import { TYPES_COMPAT } from '../src/downlevel-dts';
import { PackageJson, ProjectInfo } from '../src/project-info';

describe('Compiler', () => {
  describe('generated tsconfig', () => {
    test('will downlevel code', () => {
      // GIVEN
      const sourceDir = mkdtempSync(join(tmpdir(), 'jsii-compiler-generated-'));
      _writeDownlevelableCode(sourceDir);

      // WHEN
      const compiler = new Compiler({
        projectInfo: {
          ..._makeProjectInfo(sourceDir, 'index.d.ts'),
        },
      });
      const result = compiler.emit();

      // THEN code compiles
      expect(result.diagnostics).toHaveLength(0);
      expect(result.emitSkipped).toBe(false);
      // THEN code is downleveled
      const downleveled = readFileSync(join(sourceDir, '.types-compat/ts3.9/index.d.ts'), 'utf-8');
      expect(downleveled).toMatchInlineSnapshot(`
        "declare class MarkerA {
        }
        export type { MarkerA };
        "
      `);
      // THEN typeVersions are written
      const packageJson = readPackageJson(sourceDir);
      expect(packageJson.typesVersions).toMatchObject({
        '<=3.9': {
          '*': ['.types-compat/ts3.9/*', '.types-compat/ts3.9/*/index.d.ts'],
        },
      });
      // THEN
      const tsconfig = JSON.parse(readFileSync(join(sourceDir, 'tsconfig.json'), 'utf-8'));
      expect(tsconfig.exclude).toMatchInlineSnapshot(`
        [
          "node_modules",
          ".types-compat",
        ]
      `);
    });

    test('will downlevel code with outdir', () => {
      // GIVEN
      const outDir = 'jsii-outdir';
      const srcDir = 'jsii-srcdir';
      const projectDir = mkdtempSync(join(tmpdir(), 'jsii-compiler-generated-'));
      mkdirSync(join(projectDir, srcDir), { recursive: true });
      _writeDownlevelableCode(projectDir, srcDir);

      // WHEN
      const compiler = new Compiler({
        projectInfo: {
          ..._makeProjectInfo(projectDir, join(outDir, 'index.d.ts')),
          tsc: {
            outDir,
            rootDir: srcDir,
          },
        },
      });
      const result = compiler.emit();

      // THEN code compiles
      expect(result.diagnostics).toHaveLength(0);
      expect(result.emitSkipped).toBe(false);
      // THEN code is downleveled
      const downleveled = readFileSync(join(projectDir, outDir, '.types-compat/ts3.9/index.d.ts'), 'utf-8');
      expect(downleveled).toMatchInlineSnapshot(`
        "declare class MarkerA {
        }
        export type { MarkerA };
        "
      `);
      // THEN typeVersions are written
      const packageJson = readPackageJson(projectDir);
      expect(packageJson.typesVersions).toMatchObject({
        '<=3.9': {
          'jsii-outdir/*': ['jsii-outdir/.types-compat/ts3.9/*', 'jsii-outdir/.types-compat/ts3.9/*/index.d.ts'],
        },
      });
      // THEN
      const tsconfig = JSON.parse(readFileSync(join(projectDir, 'tsconfig.json'), 'utf-8'));
      expect(tsconfig.exclude).toMatchInlineSnapshot(`
        [
          "node_modules",
          "jsii-outdir/.types-compat",
        ]
      `);
    });
  });

  describe('user-provided tsconfig', () => {
    test('will downlevel code with outdir', () => {
      // GIVEN
      const outDir = 'jsii-outdir';
      const srcDir = 'jsii-srcdir';
      const projectDir = mkdtempSync(join(tmpdir(), 'jsii-compiler-user-tsconfig-'));
      mkdirSync(join(projectDir, srcDir), { recursive: true });
      const tsconfigPath = 'tsconfig.dev.json';
      writeFileSync(
        join(projectDir, tsconfigPath),
        JSON.stringify(
          tsconfigForNode18Strict({
            outDir,
            rootDir: srcDir,
          }),
          null,
          2,
        ),
      );
      _writeDownlevelableCode(projectDir, srcDir);

      // WHEN
      const compiler = new Compiler({
        projectInfo: _makeProjectInfo(projectDir, join(outDir, 'index.d.ts')),
        typeScriptConfig: tsconfigPath,
      });
      const result = compiler.emit();

      // THEN code compiles
      expect(result.diagnostics).toHaveLength(0);
      expect(result.emitSkipped).toBe(false);
      // THEN code is downleveled
      const downleveled = readFileSync(join(projectDir, outDir, '.types-compat/ts3.9/index.d.ts'), 'utf-8');
      expect(downleveled).toMatchInlineSnapshot(`
        "declare class MarkerA {
        }
        export type { MarkerA };
        "
      `);
      // THEN typeVersions are written
      const packageJson = readPackageJson(projectDir);
      expect(packageJson.typesVersions).toMatchObject({
        '<=3.9': {
          'jsii-outdir/*': ['jsii-outdir/.types-compat/ts3.9/*', 'jsii-outdir/.types-compat/ts3.9/*/index.d.ts'],
        },
      });
    });
  });
});

function readPackageJson(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
}

function _writeDownlevelableCode(projectDir: string, codeSubDir?: string) {
  // Files in the project dir
  writeFileSync(join(projectDir, 'README.md'), '# Test Package');
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({}, null, 2));

  // Files in the code dir, e.g. `src`
  const codeDir = codeSubDir ? join(projectDir, codeSubDir) : projectDir;
  // See https://www.npmjs.com/package/downlevel-dts#type-modifiers-on-importexport-names-45
  writeFileSync(join(codeDir, 'index.ts'), 'class MarkerA {} export { type MarkerA }');
}

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

/**
 * An example of a user-provided config, based on the popular tsconfig/bases project & adjusted for the strict rule set
 * @see https://github.com/tsconfig/bases/blob/main/bases/node18.json
 */
function tsconfigForNode18Strict(compilerOptions: any = {}) {
  return {
    compilerOptions: {
      lib: ['es2022'],
      module: 'node16',
      target: 'es2022',

      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmitOnError: true,
      moduleResolution: 'node16',
      declaration: true,
      ...compilerOptions,
    },
    exclude: ['node_modules', TYPES_COMPAT],
    include: [join('**', '*.ts')],
  };
}
