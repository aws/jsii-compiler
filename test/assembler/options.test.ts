import { compileJsiiForTest } from '../../src';

describe('stripDeprecatedAllowListFile', () => {
  // @TODO(ts7): the TypeScript 7 compiler does not check that the --strip-deprecated allow-list file exists
  test.skip('fails when the allow-list file does not exist', () => {
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
});
