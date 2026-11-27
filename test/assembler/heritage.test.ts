import { compileForDiagnostics } from './helpers';

describe('JSII3005 type-model/type-used-as-interface', () => {
  test('is reported when an interface extends a collection type', () => {
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

  test('is reported when a behavioral interface extends a class', () => {
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

  test('is reported when a struct extends a class', () => {
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
  test('a class implementing an unknown type fails with JSII9997', () => {
    expect(compileForDiagnostics('export class Klass implements Unknown {}')).toEqual([
      expect.stringMatching(
        /^JSII9997: Unknown error: Unable to resolve type: {2}Unknown\. This typically happens if something is wrong with your dependency closure\./,
      ),
      "TS2304: Cannot find name 'Unknown'.",
    ]);
  });
});
