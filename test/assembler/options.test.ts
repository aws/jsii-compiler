import * as path from 'node:path';
import { compileJsiiForTest, JsiiDiagnostic } from '../../src';

describe('stripDeprecatedAllowListFile', () => {
  test('fails when the allow-list file does not exist', () => {
    const allowListFile = '/this/file/does/not/exist.txt';

    expect(() =>
      compileJsiiForTest('export class Klass {}', undefined, {
        stripDeprecated: true,
        stripDeprecatedAllowListFile: allowListFile,
      }),
    ).toThrow(`--strip-deprecated file not found: ${allowListFile}`);
  });
});

describe('tsc outDir without rootDir', () => {
  test('no rootDir is recorded when the sources share no common directory', () => {
    // tsc then uses the project root, which is what an unset rootDir means as well.
    const result = compileJsiiForTest(
      {
        'index.ts': "export * from './lib/other';",
        'lib/other.ts': 'export class Other {}',
      },
      {
        packageJson: {
          types: 'dist/index.d.ts',
          main: 'dist/index.js',
          jsii: { tsc: { outDir: 'dist' } } as any,
        },
      },
    );

    expect(result.assembly.types).toHaveProperty(['testpkg.Other']);
    expect(result.assembly.metadata).toHaveProperty('tscOutDir', 'dist');
    expect(result.assembly.metadata).not.toHaveProperty('tscRootDir');
    expect(Object.keys(result.files)).toEqual(expect.arrayContaining(['dist/index.d.ts', 'dist/lib/other.d.ts']));
  });

  test('a "types" entry outside of the outDir is reported, with the path tsc writes the declarations to', () => {
    const result = compileJsiiForTest(
      {
        'index.ts': "export * from './lib/other';",
        'lib/other.ts': 'export class Other {}',
      },
      {
        captureDiagnostics: true,
        packageJson: {
          types: 'index.d.ts',
          jsii: { tsc: { outDir: 'dist' } } as any,
        },
      },
    );

    expect(result.type).toBe('failure');
    expect(result.diagnostics.filter(JsiiDiagnostic.isJsiiDiagnostic).map((d) => d.messageText)).toContainEqual(
      'The "types" entry in package.json ("index.d.ts") is outside of the TypeScript outDir ("dist"), so the entry ' +
        `point cannot be found. Set it to "${path.join('dist', 'index.d.ts')}" and update "main" to match.`,
    );
  });
});

describe('package.json without "types"', () => {
  test('index.ts is the entry point', () => {
    const result = compileJsiiForTest(
      { 'index.ts': 'export class Exported {}', 'other.ts': 'export class NotTheEntryPoint {}' },
      { packageJson: { types: undefined } },
    );

    expect(Object.keys(result.assembly.types!)).toEqual(['testpkg.Exported']);
  });
});
