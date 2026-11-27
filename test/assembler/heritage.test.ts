import { compileForDiagnostics } from './helpers';
import { compileJsiiForTest } from '../../src';

describe('JSII3005 type-model/type-used-as-interface', () => {
  // @TODO(ts7): expects a jsii validation diagnostic (JSII3005, or JSII9997 for an unresolvable heritage clause); re-enable with the port of the validator
  test.skip('is reported when an interface extends a collection type', () => {
    // The order in which the two are reported is not specified.
    expect(
      compileForDiagnostics(`
        export interface IStrings extends Array<string> {
          readonly extra: string;
        }
      `).sort(),
    ).toEqual([
      'JSII3004: Illegal extends clause for an exported API: VariableDeclaration',
      'JSII3005: Type "array<string>" cannot be used as an interface',
    ]);
  });

  // @TODO(ts7): expects a jsii validation diagnostic (JSII3005, or JSII9997 for an unresolvable heritage clause); re-enable with the port of the validator
  test.skip('is reported when a behavioral interface extends a class', () => {
    expect(
      compileForDiagnostics(`
        export class Klass {
          public method(): void {}
        }
        export interface IExtendsClass extends Klass {
          other(): void;
        }
      `),
    ).toEqual(['JSII3005: Type "testpkg.Klass" cannot be used as an interface']);
  });

  // @TODO(ts7): expects a jsii validation diagnostic (JSII3005, or JSII9997 for an unresolvable heritage clause); re-enable with the port of the validator
  test.skip('is reported when a struct extends a class', () => {
    expect(
      compileForDiagnostics(`
        export class Klass {
          public readonly prop: string = 'value';
        }
        export interface ExtendsClass extends Klass {
          readonly other: string;
        }
      `),
    ).toEqual(['JSII3005: Type "testpkg.Klass" cannot be used as an interface']);
  });
});

describe('unresolvable heritage clauses', () => {
  // @TODO(ts7): expects a jsii validation diagnostic (JSII3005, or JSII9997 for an unresolvable heritage clause); re-enable with the port of the validator
  test.skip('a class implementing an unknown type fails with JSII9997', () => {
    expect(compileForDiagnostics('export class Klass implements Unknown {}')).toEqual([
      expect.stringMatching(
        /^JSII9997: Unknown error: Unable to resolve type: {2}Unknown\. This typically happens if something is wrong with your dependency closure\./,
      ),
      "TS2304: Cannot find name 'Unknown'.",
    ]);
  });
});

describe('a class merged with an interface', () => {
  test('keeps the base class of the class, and ignores a class that the interface extends', () => {
    const result = compileJsiiForTest(`
      export class A {}
      export class B {}
      export class K extends A {}
      export interface K extends B {}
    `);

    expect(result.assembly.types!['testpkg.K']).toMatchObject({ kind: 'class', base: 'testpkg.A' });
    expect(result.assembly.types!['testpkg.K']).not.toHaveProperty('interfaces');
  });
});
