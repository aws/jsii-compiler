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

  test('is reported when an override becomes variadic', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export class Base {
        public method(item: string) {
          return item;
        }
      }
      export class Derived extends Base {
        public method(...items: string[]) {
          return items[0];
        }
      }
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 5007,
        messageText: '"testpkg.Derived#method" turns variadic when overriding testpkg.Base. Make it non-variadic',
      }),
    );
  });
});

describe('JSII5008 language-compatibility/override-changes-param-optional', () => {
  test('is reported when an override makes a required parameter optional', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export class Base {
        public method(a: string) {
          return a;
        }
      }
      export class Derived extends Base {
        public method(a?: string) {
          return a ?? '';
        }
      }
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 5008,
        messageText:
          '"testpkg.Derived#method" turns parameter "a" optional when overriding testpkg.Base. Make it required',
      }),
    );
  });
});

describe('JSII5009 language-compatibility/override-changes-prop-optional', () => {
  test('is reported when an override makes a required property optional', () => {
    // TypeScript accepts this for "any", which already includes undefined.
    const diagnostics = compileJsiiForDiagnostics(`
      export class Base {
        public prop: any = 1;
      }
      export class Derived extends Base {
        public prop?: any = 1;
      }
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 5009,
        messageText: '"testpkg.Derived#prop" turns optional when overriding testpkg.Base. Make it required',
      }),
    );
  });
});

describe('JSII5014 language-compatibility/inherited-static-conflict', () => {
  test('is reported when a static member has the name of an instance member of the base class', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export class Base {
        public foo() {
          return 1;
        }
      }
      export class Derived extends Base {
        public static foo() {
          return 2;
        }
      }
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 5014,
        messageText:
          'Static member "foo" of class "testpkg.Derived" conflicts with instance member in ancestor "testpkg.Base"',
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

describe('JSII5001 language-compatibility/potential-java-setter-conflict', () => {
  test('is reported for a "setXxx" method with one parameter', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export class Klass {
        public setFoo(_value: string) {
          return;
        }
      }
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 5001,
        messageText:
          'Methods and properties cannot have names like "setXxx": those conflict with Java property setters. Rename "Klass.setFoo"',
      }),
    );
  });

  test('is not reported for a "setXxx" method without a parameter, which is not a Java setter', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export class Klass {
        public setFoo() {
          return;
        }
      }
    `);

    expect(diagnostics.map((d) => d.jsiiCode)).not.toContain(5001);
  });
});
