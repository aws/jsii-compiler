import { compileJsiiForDiagnostics } from '../compiler-helpers';

describe('JSII5005 language-compatibility/override-changes-param-count', () => {
  test('is reported when an override adds a parameter', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export class Base {
        public method(a: string) {
          return a;
        }
      }
      export class Derived extends Base {
        public method(a: string, b: string) {
          return a + b;
        }
      }
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 5005,
        messageText:
          '"testpkg.Derived#method" has 2 parameters when overriding testpkg.Base. It should accept 1 parameters',
      }),
    );
  });
});

describe('JSII5007 language-compatibility/override-changes-variadic', () => {
  test('is reported when an override stops being variadic', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export class Base {
        public method(...items: string[]) {
          return items;
        }
      }
      export class Derived extends Base {
        public method(items: string[]) {
          return items;
        }
      }
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 5007,
        messageText: '"testpkg.Derived#method" turns non variadic when overriding testpkg.Base. Make it variadic',
      }),
    );
  });
});

describe('JSII5012 language-compatibility/namespace-in-type', () => {
  test('is reported when a namespace is nested in a class namespace', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export class Klass {}
      export namespace Klass {
        export class Nested {}
      }
      export namespace Klass.Inner {
        export class Deeper {}
      }
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 5012,
        messageText: expect.stringContaining('All entities nested under a type (e.g: "testpkg.Klass")'),
      }),
    );
  });
});
