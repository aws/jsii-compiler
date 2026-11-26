import { compileJsiiForDiagnostics } from '../compiler-helpers';

describe('JSII1001 typescript-restrictions/type-has-no-symbol', () => {
  test('is reported for `null` used as a type', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export class Klass {
        public method(_arg: null) {}
      }
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 1001,
        messageText: 'Non-primitive types without a symbol cannot be processed.',
      }),
    );
  });
});

describe('JSII1002 typescript-restrictions/unspecified-promise', () => {
  test('is reported when a user-defined "Promise" type has no type arguments', () => {
    // TypeScript itself rejects a bare `Promise`, so the only way to get there is to shadow the global type.
    const diagnostics = compileJsiiForDiagnostics(`
      interface Promise {}
      export class Klass {
        public method(): Promise {
          return null as any;
        }
      }
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 1002,
        messageText: 'Un-specified promise type. Specify it using "Promise<T>"',
      }),
    );
  });
});

describe('JSII1012 typescript-restrictions/only-const-enum-members', () => {
  test('is reported when an enum member is computed', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export enum Mode {
        COMPUTED = 'abc'.length,
        CONSTANT = 2,
      }
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 1012,
        messageText: 'Only constant enum members are allowed',
      }),
    );
  });
});
