import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { compileJsiiForTest } from '../../src/helpers';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsii-generated-tsconfig-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Compiles a small project, and returns the tsconfig.json that jsii generated for it. */
function generatedTsconfig(
  jsii: Record<string, unknown> = {},
  source = 'export class Klass {}',
  packageJson: Record<string, unknown> = {},
) {
  compileJsiiForTest(source, { compilationDirectory: dir, packageJson: { ...packageJson, jsii } as any });
  return JSON.parse(fs.readFileSync(path.join(dir, 'tsconfig.json'), 'utf-8'));
}

describe('the generated tsconfig.json', () => {
  test('has the compiler options that jsii requires', () => {
    expect(generatedTsconfig().compilerOptions).toMatchObject({
      declaration: true,
      strict: true,
      noEmitOnError: true,
      skipLibCheck: true,
      target: 'es2023',
      lib: ['es2023'],
      module: 'node20',
      esModuleInterop: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
    });
  });

  test('includes all TypeScript files, and excludes node_modules', () => {
    const tsconfig = generatedTsconfig();

    expect(tsconfig.include).toEqual(['**/*.ts']);
    expect(tsconfig.exclude).toEqual(['node_modules']);
  });

  test('excludes the files of jsii.excludeTypescript', () => {
    expect(generatedTsconfig({ excludeTypescript: ['scripts/**', 'test/**'] }).exclude).toEqual([
      'node_modules',
      'scripts/**',
      'test/**',
    ]);
  });

  test('compiles into jsii.tsc.outDir, and leaves the compiled files out of the sources', () => {
    const tsconfig = generatedTsconfig({ tsc: { outDir: 'lib' } }, 'export class Klass {}', {
      main: 'lib/index.js',
      types: 'lib/index.d.ts',
    });

    expect(tsconfig.compilerOptions.outDir).toBe('lib');
    expect(tsconfig.exclude).toEqual(['node_modules', 'lib/**/*.ts']);
  });

  test('passes the optional jsii.tsc settings to TypeScript', () => {
    expect(
      generatedTsconfig({
        tsc: {
          forceConsistentCasingInFileNames: true,
          noImplicitOverride: true,
          noPropertyAccessFromIndexSignature: true,
          noUncheckedIndexedAccess: true,
        },
      }).compilerOptions,
    ).toMatchObject({
      forceConsistentCasingInFileNames: true,
      noImplicitOverride: true,
      noPropertyAccessFromIndexSignature: true,
      noUncheckedIndexedAccess: true,
    });
  });

  test('does not set the optional jsii.tsc settings that were not given', () => {
    const options = generatedTsconfig().compilerOptions;

    for (const option of [
      'noImplicitOverride',
      'noUncheckedIndexedAccess',
      'noPropertyAccessFromIndexSignature',
      'outDir',
      'rootDir',
      'paths',
    ]) {
      expect(options).not.toHaveProperty(option);
    }
  });

  test('embeds the source maps in the compiled files by default', () => {
    const options = generatedTsconfig().compilerOptions;

    expect(options).toMatchObject({ inlineSourceMap: true, inlineSources: true });
    expect(options.sourceMap).toBeUndefined();
  });

  test('is not a composite project by default', () => {
    expect(generatedTsconfig().compilerOptions.composite).toBe(false);
  });

  test('is a composite project when jsii.projectReferences is set', () => {
    expect(generatedTsconfig({ projectReferences: true }).compilerOptions.composite).toBe(true);
  });
});
