import * as spec from '@jsii/spec';
import { DiagnosticCategory } from 'typescript';
import { compileForDiagnostics } from './helpers';
import { compileJsiiForTest } from '../../src/helpers';

describe('JSII9998 miscellaneous/unsupported-node', () => {
  test('is reported for a static initialization block', () => {
    expect(
      compileForDiagnostics(`
        export class Klass {
          public static value = 0;
          static {
            Klass.value = 1;
          }
        }
      `),
    ).toEqual([
      'JSII9998: Unsupported ClassStaticBlockDeclaration node. This declaration will not be accessible from other languages.',
    ]);
  });
});

describe('JSII5016 language-compatibility/prohibited-member-name', () => {
  test('is reported for a class property', () => {
    expect(compileForDiagnostics("export class Klass { public readonly equals: string = 'value'; }")).toEqual([
      'JSII5016: Members cannot be named "equals" as it conflicts with synthetic declarations in some languages.',
    ]);
  });

  test('is reported for an interface property, regardless of case', () => {
    expect(compileForDiagnostics('export interface IInterface { readonly hashCode: string }')).toEqual([
      'JSII5016: Members cannot be named "hashCode" as it conflicts with synthetic declarations in some languages.',
    ]);
  });
});

describe('JSII8000 code-style/type-names-must-use-pascal-case', () => {
  test('is reported for a struct', () => {
    expect(compileForDiagnostics('export interface struct_name { readonly prop: string }')).toEqual([
      'JSII8000: Type names must be PascalCased. Rename "struct_name" to "StructName"',
    ]);
  });

  test('keeps the "I" prefix of a behavioral interface', () => {
    expect(compileForDiagnostics('export interface IBehavior_name { method(): void }')).toEqual([
      'JSII8000: Type names must be PascalCased. Rename "IBehavior_name" to "IBehaviorName"',
    ]);
  });
});

describe('accessors', () => {
  test('a setter without a type annotation takes the type of its getter', () => {
    const result = compileJsiiForTest(`
      export class Klass {
        private _value = '';
        public get value(): string {
          return this._value;
        }
        public set value(value) {
          this._value = value;
        }
      }
    `);

    const klass = result.assembly.types!['testpkg.Klass'] as spec.ClassType;
    expect(klass.properties).toEqual([
      expect.objectContaining({ name: 'value', type: { primitive: spec.PrimitiveType.String } }),
    ]);
    // It is a mutable property, without JSII1005 (separate write type).
    expect(klass.properties![0].immutable).toBeUndefined();
    expect(result.diagnostics.filter((d) => d.category === DiagnosticCategory.Error)).toEqual([]);
  });
});

describe('JSII5010 / JSII5015 re-declaration of interface members', () => {
  // See https://github.com/aws/jsii-compiler/issues/2970
  test('a property that changes its shape is reported as JSII5015', () => {
    expect(
      compileForDiagnostics(`
        export interface IA {
          readonly foo: string;
        }
        export interface IB extends IA {
          foo: string;
        }
      `),
    ).toEqual([
      'JSII5015: Interface "testpkg.IB" re-declares member "foo" with a different type or signature. Re-declared members must match the inherited declaration exactly, as C# interfaces cannot narrow inherited members.',
    ]);
  });
});
