import { compileForDiagnostics } from './helpers';
import { compileJsiiForTest } from '../../src';

// Broken re-exports are TypeScript errors. The assembler leaves reporting them to tsc.
describe('re-exports that TypeScript cannot resolve', () => {
  test('"export { Name } from" a missing module only reports the TypeScript error', () => {
    expect(compileForDiagnostics("export { Name } from './missing';")).toEqual([
      "TS2307: Cannot find module './missing' or its corresponding type declarations.",
    ]);
  });

  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2952
  // @TODO(ts7): the TypeScript 7 assembler reports no JSII9997 here
  test.skip('"export * as ns from" a missing module also fails with JSII9997', () => {
    expect(compileForDiagnostics("export * as ns from './missing';")).toEqual([
      expect.stringMatching(/^JSII9997: Unknown error: Cannot read properties of undefined \(reading 'flags'\)/),
      "TS2307: Cannot find module './missing' or its corresponding type declarations.",
    ]);
  });

  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2952
  // @TODO(ts7): the TypeScript 7 assembler reports no JSII9997 here
  test.skip('"export * as ns from" a module specifier that is not a string also fails with JSII9997', () => {
    expect(compileForDiagnostics('export * as ns from specifier;')).toEqual([
      expect.stringMatching(/^JSII9997: Unknown error: Cannot read properties of undefined \(reading 'flags'\)/),
      'TS1141: String literal expected.',
    ]);
  });
});

describe('"export =" in the entry point', () => {
  test('of a namespace with only a declaration exports no type', () => {
    const result = compileJsiiForTest('declare namespace ns { class A {} } export = ns;');

    expect(result.assembly.types ?? {}).toEqual({});
  });

  test('of a class merged with a namespace exports what the namespace contains, not the class', () => {
    const result = compileJsiiForTest('class K {} namespace K { export class Inner {} } export = K;');

    expect(Object.keys(result.assembly.types!)).toEqual(['testpkg.Inner']);
  });

  test.each([
    ['a class merged with a namespace', 'class K {} namespace K { export class I {} } export = K;'],
    ['a declared class merged with a namespace', 'declare class K {} declare namespace K { class I {} } export = K;'],
  ])('in a submodule cannot be re-exported as a namespace: %s', (_, submodule) => {
    expect(compileForDiagnostics({ 'index.ts': "export * as sub from './sub'", 'sub.ts': submodule })).toEqual([
      expect.stringMatching(/^TS2498: Module '".*sub"' uses 'export =' and cannot be used with 'export \*'\.$/),
    ]);
  });
});

describe('a namespace declared before the class it is merged with', () => {
  test('is reported by TypeScript only', () => {
    expect(
      compileForDiagnostics(`
        export namespace outer {
          export namespace K { export class I {} }
          export class K {}
        }
      `),
    ).toEqual([
      'TS2434: A namespace declaration cannot be located prior to a class or function with which it is merged.',
    ]);
  });
});
