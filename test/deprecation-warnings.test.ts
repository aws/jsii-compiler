// eslint-disable-next-line import/no-extraneous-dependencies
// Collission with non-deprecated enum member
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as vm from 'node:vm';

import { compile, Lock } from './fixtures';
import { OutputCapture } from './output-helpers';
import { compileJsiiForTest, HelperCompilationResult, TestWorkspace } from '../lib';

const DEPRECATED = '/** @deprecated Use something else */';

beforeEach(() => {
  jest.restoreAllMocks();
});

describe('Function generation', () => {
  test('generates the print function', () => {
    const result = compileJsiiForTest('', undefined /* callback */, {
      addDeprecationWarnings: true,
    });

    expect(jsFile(result, '.warnings.jsii')).toContain(
      `function print(name, deprecationMessage) {
    if (ALREADY_WARNED.has(name)) {
        return;
    }
    ALREADY_WARNED.add(name);
    const deprecated = process.env.JSII_DEPRECATED;
    const deprecationMode = ["warn", "fail", "quiet"].includes(deprecated) ? deprecated : "warn";
    const message = \`\${name} is deprecated, and will be removed in the next major release.\\n  \${deprecationMessage.trim()}\`;
    switch (deprecationMode) {
        case "fail":
            throw new DeprecationError(message);
        case "warn":
            console.warn("[WARNING]", message);
            break;
    }
}
const ALREADY_WARNED = new Set();
function getPropertyDescriptor(obj, prop) {
    const descriptor = Object.getOwnPropertyDescriptor(obj, prop);
    if (descriptor) {
        return descriptor;
    }
    const proto = Object.getPrototypeOf(obj);
    const prototypeDescriptor = proto && getPropertyDescriptor(proto, prop);
    if (prototypeDescriptor) {
        return prototypeDescriptor;
    }
    return {};
}
const visitedObjects = new Set();
class DeprecationError extends Error {
    constructor(...args) {
        super(...args);
        Object.defineProperty(this, "name", {
            configurable: false,
            enumerable: true,
            value: "DeprecationError",
            writable: false,
        });
    }
}
`,
    );
  });

  test('generates validation functions only for types with deprecated members', () => {
    const result = compileJsiiForTest(
      `
        export interface Foo {
          /**
           * @deprecated Do not use
           */
          readonly foo: string;
        }
        export interface Bar {}
        export interface Baz {}
        `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    expect(jsFile(result, '.warnings.jsii')).toContain('testpkg_Foo(');
    expect(jsFile(result, '.warnings.jsii')).not.toContain('testpkg_Bar(');
    expect(jsFile(result, '.warnings.jsii')).not.toContain('testpkg_Baz(');
  });

  test('generates metadata', () => {
    const result = compileJsiiForTest(
      `
        export interface Foo {}
        export interface Bar {}
        export interface Baz {}
        `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );
    expect(result.assembly.metadata?.jsii?.compiledWithDeprecationWarnings).toBe(true);
  });

  test('generates a call for calling into objects with deprecated members', () => {
    const result = compileJsiiForTest(
      `
        export interface Foo {
          /**
           * @deprecated Do not use
           */
          readonly foo: string;
        }
        export interface Bar {}
        export interface Baz {
          readonly foo: Foo;
          readonly bar: Bar;
          readonly x: string;
        }
        `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    expect(jsFunction(result, 'testpkg_Baz', '.warnings.jsii')).toMatchInlineSnapshot(`
      "function testpkg_Baz(p) {
              if (p == null)
                  return;
              visitedObjects.add(p);
              try {
                  if (!visitedObjects.has(p.foo))
                      module.exports.testpkg_Foo(p.foo);
              }
              finally {
                  visitedObjects.delete(p);
              }
          } "
    `);
  });

  test('generates no functions for interfaces', () => {
    const result = compileJsiiForTest(
      `
        export interface IFoo {
          bar(): string;
        }
        `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    expect(jsFile(result, '.warnings.jsii')).not.toContain('testpkg_IFoo(');
  });

  test('generates no functions for classes', () => {
    const result = compileJsiiForTest(
      `
        export class Foo {
          bar() {return 0};
        }
        `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    expect(jsFile(result, '.warnings.jsii')).not.toContain(`testpkg_Foo(`);
  });

  test('generates calls for recursive types', () => {
    const result = compileJsiiForTest(
      `
        export interface Bar {readonly bar?: Bar}
        `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    expect(jsFunction(result, 'testpkg_Bar', '.warnings.jsii')).toMatchInlineSnapshot(`
      "function testpkg_Bar(p) {
              if (p == null)
                  return;
              visitedObjects.add(p);
              try {
                  if (!visitedObjects.has(p.bar))
                      module.exports.testpkg_Bar(p.bar);
              }
              finally {
                  visitedObjects.delete(p);
              }
          } "
    `);
  });

  test('checks array elements', () => {
    const result = compileJsiiForTest(
      `
      export interface Used {
        /**
         * @deprecated Oh no
         */
        readonly property: boolean;
      }
      export interface Uses { readonly array: Used[]; }
      `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    expect(jsFunction(result, 'testpkg_Uses', '.warnings.jsii')).toMatchInlineSnapshot(`
      "function testpkg_Uses(p) {
              if (p == null)
                  return;
              visitedObjects.add(p);
              try {
                  if (p.array != null)
                      for (const o of p.array)
                          if (!visitedObjects.has(o))
                              module.exports.testpkg_Used(o);
              }
              finally {
                  visitedObjects.delete(p);
              }
          } "
    `);
  });

  test('checks map elements', () => {
    const result = compileJsiiForTest(
      `
      export interface Used {
        /**
         * @deprecated Oh no
         */
        readonly property: boolean;
      }
      export interface Uses { readonly map: Record<string, Used>; }
      `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    expect(jsFunction(result, 'testpkg_Uses', '.warnings.jsii')).toMatchInlineSnapshot(`
      "function testpkg_Uses(p) {
              if (p == null)
                  return;
              visitedObjects.add(p);
              try {
                  if (p.map != null)
                      for (const o of Object.values(p.map))
                          if (!visitedObjects.has(o))
                              module.exports.testpkg_Used(o);
              }
              finally {
                  visitedObjects.delete(p);
              }
          } "
    `);
  });

  test('generates functions for enums', () => {
    const result = compileJsiiForTest(
      `
        export enum State {
          ON,

          ${DEPRECATED}
          OFF
        }
        `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    expect(jsFunction(result, 'testpkg_State', '.warnings.jsii')).toMatchInlineSnapshot(`
      "function testpkg_State(p) {
              if (p == null)
                  return;
              visitedObjects.add(p);
              try {
                  if (p === 1)
                      print("testpkg.State#OFF", "Use something else");
              }
              finally {
                  visitedObjects.delete(p);
              }
          } "
    `);
  });

  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/3001
  test('drops the comments at the end of a method body in the emitted JavaScript', () => {
    const source = `
      export class A {
        public static method(): void {
          /* A static method */
        }
        public withBody(): number {
          // leading
          return 1;
          // after
        }
      }
    `;

    const without = compileJsiiForTest(source);
    const withWarnings = compileJsiiForTest(source, undefined /* callback */, { addDeprecationWarnings: true });

    expect(without.files['index.js']).toContain('/* A static method */');
    expect(without.files['index.js']).toContain('// after');
    expect(withWarnings.files['index.js']).toContain('// leading');
    expect(withWarnings.files['index.js']).not.toContain('/* A static method */');
    expect(withWarnings.files['index.js']).not.toContain('// after');
  });

  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2949
  // @TODO(ts7): main fails with JSII9997 here (https://github.com/aws/jsii-compiler/issues/2949); the TypeScript 7 compiler succeeds
  test.skip('fails with JSII9997 for an enum with a deprecated member and a member whose name is a string literal', () => {
    const result = compileJsiiForTest(
      `
        export enum E {
          ON,
          ${DEPRECATED}
          OFF = 1,
          'B' = 5,
        }
      `,
      { captureDiagnostics: true },
      { addDeprecationWarnings: true },
    );

    expect(result.type).toBe('failure');
    expect(result.diagnostics.map((d) => `${d.messageText}`)).toEqual([
      expect.stringContaining('Unknown error: Converting circular structure to JSON'),
    ]);
  });

  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2961
  // A member that shares its value with another member (written differently, so JSII1004 does not apply) is
  // dropped from the assembly, so the validator never sees it. This is also why the "collision with
  // non-deprecated enum member" branch of the transform cannot be reached.
  test('does not warn for a deprecated enum member whose value is shared with a non-deprecated member', () => {
    const result = compileJsiiForTest(
      `
        export enum State {
          ON = 1,

          ${DEPRECATED}
          LEGACY_ON = 0x1,

          ${DEPRECATED}
          OFF = 2,
        }
        `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    const validator = jsFunction(result, 'testpkg_State', '.warnings.jsii');
    expect(validator).toContain('print("testpkg.State#OFF", "Use something else")');
    expect(validator).not.toContain('LEGACY_ON');
    expect(result.assembly.types!['testpkg.State']).toHaveProperty('members', [
      { name: 'ON' },
      { name: 'OFF', docs: { deprecated: 'Use something else', stability: 'deprecated' } },
    ]);
  });

  test('generates calls for deprecated inherited properties', () => {
    const result = compileJsiiForTest(
      `
        export interface Baz {
          /** @deprecated message from Baz */
          readonly x: string;
        }
        export interface Bar {
          /** @deprecated message from Bar */
          readonly x: string;
        }
        export interface Foo extends Bar, Baz {
        }
        `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    // For each supertype, its corresponding function should be generated, as usual
    expect(jsFunction(result, 'testpkg_Baz', '.warnings.jsii')).toMatchInlineSnapshot(`
      "function testpkg_Baz(p) {
              if (p == null)
                  return;
              visitedObjects.add(p);
              try {
                  if ("x" in p)
                      print("testpkg.Baz#x", "message from Baz");
              }
              finally {
                  visitedObjects.delete(p);
              }
          },"
    `);

    expect(jsFunction(result, 'testpkg_Bar', '.warnings.jsii')).toMatchInlineSnapshot(`
      "function testpkg_Bar(p) {
              if (p == null)
                  return;
              visitedObjects.add(p);
              try {
                  if ("x" in p)
                      print("testpkg.Bar#x", "message from Bar");
              }
              finally {
                  visitedObjects.delete(p);
              }
          },"
    `);

    expect(jsFunction(result, 'testpkg_Foo', '.warnings.jsii')).toMatchInlineSnapshot(`
      "function testpkg_Foo(p) {
              if (p == null)
                  return;
              visitedObjects.add(p);
              try {
                  if ("x" in p)
                      print("testpkg.Baz#x", "message from Baz");
              }
              finally {
                  visitedObjects.delete(p);
              }
          } "
    `);
  });

  test('skips properties that are deprecated in one supertype but not the other', () => {
    const result = compileJsiiForTest(
      `
        export interface Baz {
          readonly x: string;
        }
        export interface Bar {
          /** @deprecated message from Bar */
          readonly x: string;
        }
        export interface Foo extends Bar, Baz {
        }
        `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    const warningsFileContent = jsFile(result, '.warnings.jsii');

    expect(warningsFileContent).not.toContain(`function testpkg_Foo(p)`);
  });

  test('generates calls for types with deprecated properties', () => {
    const result = compileJsiiForTest(
      `
      export interface Bar {
        readonly x: string;
      }

      export interface Foo {
        readonly y: string;

        /** @deprecated kkkkkkkk */
        readonly bar: Bar;
      }
      `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    expect(jsFunction(result, 'testpkg_Foo', '.warnings.jsii')).toMatchInlineSnapshot(`
      "function testpkg_Foo(p) {
              if (p == null)
                  return;
              visitedObjects.add(p);
              try {
                  if ("bar" in p)
                      print("testpkg.Foo#bar", "kkkkkkkk");
              }
              finally {
                  visitedObjects.delete(p);
              }
          } "
    `);
  });

  test('generates calls for each property of a deprecated type', () => {
    const result = compileJsiiForTest(
      `
      /** @deprecated use Bar instead */
      export interface Foo {
        readonly bar: string;
        readonly baz: number;
      }
      `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    expect(jsFunction(result, 'testpkg_Foo', '.warnings.jsii')).toMatchInlineSnapshot(`
      "function testpkg_Foo(p) {
              if (p == null)
                  return;
              visitedObjects.add(p);
              try {
                  if ("bar" in p)
                      print("testpkg.Foo#bar", "use Bar instead");
                  if ("baz" in p)
                      print("testpkg.Foo#baz", "use Bar instead");
              }
              finally {
                  visitedObjects.delete(p);
              }
          } "
    `);
  });

  describe('using fixtures', () => {
    let lock: Lock | undefined;

    beforeEach(async () => {
      lock = await Lock.acquire();
    }, 120_000);

    afterEach(async () => {
      await lock?.release();
      lock = undefined;
    }, 120_000);

    test('generates calls for types in other assemblies', async () => {
      compile(lock!, '@scope/jsii-calc-base-of-base', true);
      const calcBaseRoot = compile(lock!, '@scope/jsii-calc-base', true);
      compile(lock!, '@scope/jsii-calc-lib', true, 'deprecated-to-strip.txt');
      const warningsFile = loadWarningsFile(calcBaseRoot);

      // jsii-calc-base was compiled with warnings, and references a type in jsii-calc-base-of-base.
      // So we expect to see handlers for its types in the warnings file
      // and we expect it to call into base-of-base.
      expect(extractFunction(warningsFile, '_scope_jsii_calc_base_TypeToContainVeryBaseProps')).toMatchInlineSnapshot(`
        "function _scope_jsii_calc_base_TypeToContainVeryBaseProps(p) {
                if (p == null)
                    return;
                visitedObjects.add(p);
                try {
                    if (p.veryBaseProps != null)
                        for (const o of p.veryBaseProps)
                            if (!visitedObjects.has(o))
                                try {
                                    require("@scope/jsii-calc-base-of-base/.warnings.jsii.js")._scope_jsii_calc_base_of_base_VeryBaseProps(o);
                                }
                                catch (error) {
                                    if (error?.name === "DeprecationError")
                                        throw error;
                                }
                }
                finally {
                    visitedObjects.delete(p);
                }
            },"
      `);

      // Recompiling without deprecation warning to leave the packages in a clean state
      compile(lock!, '@scope/jsii-calc-base', false);
      compile(lock!, '@scope/jsii-calc-lib', false, 'deprecated-to-strip.txt');
    }, 120_000);
  });
});

describe('cross-assembly validation', () => {
  test.each([
    ['ForeignProps', '{ old: "value" }', 'warn', 'present'],
    ['ForeignProps', '{ old: "value" }', 'fail', 'present'],
    ['ForeignProps', '{ old: "value" }', 'quiet', 'present'],
    ['ForeignProps', '{ old: "value" }', 'warn', 'missing'],
    ['ForeignProps', '{ old: "value" }', 'warn', 'no-handler'],
    ['ForeignProps', '{ old: "value" }', 'warn', 'disabled'],
    ['ForeignProps', 'undefined', 'warn', 'present'],
    ['ForeignProps[]', '[{ old: "value" }]', 'warn', 'present'],
    ['{ [key: string]: ForeignProps }', '{ key: { old: "value" } }', 'warn', 'present'],
    ['ForeignProps | string', '{ old: "value" }', 'warn', 'present'],
    ['ForeignProps | string', '{ old: "value" }', 'fail', 'present'],
  ])('validates %s with %s in %s mode and %s warnings', (type, value, mode, warnings) => {
    TestWorkspace.withWorkspace((ws) => {
      const dependency = compileJsiiForTest(
        `export interface ForeignProps {
          /** @deprecated use new instead */
          readonly old?: string;
        }`,
        { packageJson: { name: 'foreign' } },
        { addDeprecationWarnings: warnings !== 'disabled' },
      );
      ws.addDependency(dependency);
      const consumer = compileJsiiForTest(
        `import { ForeignProps } from 'foreign';
        export interface Props { readonly field?: ${type}; }
        export class Consumer {
          public static consume(props: Props): Props { return props; }
        }
        Consumer.consume({ field: ${value} });`,
        {
          compilationDirectory: ws.rootDirectory,
          packageJson: { dependencies: { foreign: '0.0.1' } },
        },
        { addDeprecationWarnings: true },
      );
      const warningsFile = path.join(ws.dependencyDir('foreign'), '.warnings.jsii.js');
      if (warnings === 'missing') {
        fs.unlinkSync(warningsFile);
      } else if (warnings === 'no-handler') {
        fs.writeFileSync(warningsFile, 'module.exports = {};');
      }
      const requireDependency = createRequire(path.join(ws.rootDirectory, 'index.js'));
      const capture = new OutputCapture('warn');
      const previousMode = process.env.JSII_DEPRECATED;
      process.env.JSII_DEPRECATED = mode;
      try {
        const run = () => runJsiiCode(consumer, 'warn', { require: requireDependency });
        if (mode === 'fail') {
          expect(run).toThrow('foreign.ForeignProps#old is deprecated');
        } else {
          expect(run).not.toThrow();
          if (mode === 'warn' && warnings === 'present' && value !== 'undefined') {
            expect(capture.output).toContain('[WARNING] foreign.ForeignProps#old is deprecated');
          } else {
            expect(capture.output).toBe('');
          }
        }
      } finally {
        capture.stop();
        if (previousMode === undefined) {
          delete process.env.JSII_DEPRECATED;
        } else {
          process.env.JSII_DEPRECATED = previousMode;
        }
      }
    });
  });
});

describe('Call injections', () => {
  test('does not add warnings by default', () => {
    const result = compileJsiiForTest(
      `
    export class Foo {
      ${DEPRECATED}
      public bar(){}
    }
  `,
    );

    expect(jsFile(result)).toMatch('bar() { }');
    expect(result.assembly.metadata?.jsii?.compiledWithDeprecationWarnings).toBeFalsy();
  });

  test('generates a require statement', () => {
    const result = compileJsiiForTest(
      {
        'index.ts': "export * from './some/folder/source'",
        'some/folder/source.ts': `
          export class Foo {
            ${DEPRECATED}
            public bar(){}
          }
        `,
      },
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    const expectedPath = ['..', '..', '.warnings.jsii.js'].join('/');

    const content = jsFile(result, 'some/folder/source');
    expect(content).toContain(`const jsiiDeprecationWarnings = require("${expectedPath}")`);
  }, 60000);

  test('does not generate a require statement when no calls were injected', () => {
    const result = compileJsiiForTest(
      {
        'index.ts': "export * from './some/folder/handler'",
        'some/folder/handler.ts': `
          export function handler(event: any) { return event; }
        `,
      },
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    const expectedPath = ['..', '..', '.warnings.jsii.js'].join('/');

    const content = jsFile(result, 'some/folder/handler');
    expect(content).not.toContain(`const jsiiDeprecationWarnings = require("${expectedPath}")`);
  }, 60000);

  test('deprecated methods', () => {
    const result = compileJsiiForTest(
      `
    export class Foo {
      ${DEPRECATED}
      public bar(){}
    }
  `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    expect(withoutSourceMap(jsFile(result))).toMatchInlineSnapshot(`
      ""use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.Foo = void 0;
      const jsiiDeprecationWarnings = require("./.warnings.jsii.js");
      const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
      class Foo {
          static [JSII_RTTI_SYMBOL_1] = { fqn: "testpkg.Foo", version: "0.0.1" };
          /** @deprecated Use something else */
          bar() { try {
              jsiiDeprecationWarnings.print("testpkg.Foo#bar", "Use something else");
          }
          catch (error) {
              if (process.env.JSII_DEBUG !== "1" && error.name === "DeprecationError") {
                  Error.captureStackTrace(error, this.bar);
              }
              throw error;
          } }
      }
      exports.Foo = Foo;"
    `);
  });

  test('methods with parameters', () => {
    const result = compileJsiiForTest(
      `
        export interface A {readonly x: number;}
         export class Foo {
          public bar(a: A, b: number){return a.x + b;}
         }`,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    expect(withoutSourceMap(jsFile(result))).toMatchInlineSnapshot(`
      ""use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.Foo = void 0;
      const jsiiDeprecationWarnings = require("./.warnings.jsii.js");
      const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
      class Foo {
          static [JSII_RTTI_SYMBOL_1] = { fqn: "testpkg.Foo", version: "0.0.1" };
          bar(a, b) { try {
              jsiiDeprecationWarnings.testpkg_A(a);
          }
          catch (error) {
              if (process.env.JSII_DEBUG !== "1" && error.name === "DeprecationError") {
                  Error.captureStackTrace(error, this.bar);
              }
              throw error;
          } return a.x + b; }
      }
      exports.Foo = Foo;"
    `);
  }, 60000);

  test('deprecated getters', () => {
    const result = compileJsiiForTest(
      `
    export class Foo {
      private _x = 0;
      ${DEPRECATED}
      public get x(){return this._x}
    }
  `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    expect(withoutSourceMap(jsFile(result))).toMatchInlineSnapshot(`
      ""use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.Foo = void 0;
      const jsiiDeprecationWarnings = require("./.warnings.jsii.js");
      const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
      class Foo {
          static [JSII_RTTI_SYMBOL_1] = { fqn: "testpkg.Foo", version: "0.0.1" };
          _x = 0;
          /** @deprecated Use something else */
          get x() { try {
              jsiiDeprecationWarnings.print("testpkg.Foo#x", "Use something else");
          }
          catch (error) {
              if (process.env.JSII_DEBUG !== "1" && error.name === "DeprecationError") {
                  Error.captureStackTrace(error, jsiiDeprecationWarnings.getPropertyDescriptor(this, "x").get);
              }
              throw error;
          } return this._x; }
      }
      exports.Foo = Foo;"
    `);
  });

  test('deprecated setters', () => {
    const result = compileJsiiForTest(
      `
    export class Foo {
      private _x = 0;
      public get x(){return this._x}

      ${DEPRECATED}
      public set x(_x: number) {this._x = _x;}
    }
  `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    expect(withoutSourceMap(jsFile(result))).toMatchInlineSnapshot(`
      ""use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.Foo = void 0;
      const jsiiDeprecationWarnings = require("./.warnings.jsii.js");
      const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
      class Foo {
          static [JSII_RTTI_SYMBOL_1] = { fqn: "testpkg.Foo", version: "0.0.1" };
          _x = 0;
          get x() { try {
              jsiiDeprecationWarnings.print("testpkg.Foo#x", "Use something else");
          }
          catch (error) {
              if (process.env.JSII_DEBUG !== "1" && error.name === "DeprecationError") {
                  Error.captureStackTrace(error, jsiiDeprecationWarnings.getPropertyDescriptor(this, "x").get);
              }
              throw error;
          } return this._x; }
          /** @deprecated Use something else */
          set x(_x) { try {
              jsiiDeprecationWarnings.print("testpkg.Foo#x", "Use something else");
          }
          catch (error) {
              if (process.env.JSII_DEBUG !== "1" && error.name === "DeprecationError") {
                  Error.captureStackTrace(error, jsiiDeprecationWarnings.getPropertyDescriptor(this, "x").set);
              }
              throw error;
          } this._x = _x; }
      }
      exports.Foo = Foo;"
    `);
  });

  test('creates a new instance of error when test', () => {
    const result = compileJsiiForTest(
      `
    ${DEPRECATED}
    export class Foo {
      constructor(){}
    }
  `,
      undefined /* callback */,
      { addDeprecationWarnings: true },
    );

    expect(withoutSourceMap(jsFile(result))).toMatchInlineSnapshot(`
      ""use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.Foo = void 0;
      const jsiiDeprecationWarnings = require("./.warnings.jsii.js");
      const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
      /** @deprecated Use something else */
      class Foo {
          static [JSII_RTTI_SYMBOL_1] = { fqn: "testpkg.Foo", version: "0.0.1" };
          constructor() { try {
              jsiiDeprecationWarnings.print("testpkg.Foo", "Use something else");
          }
          catch (error) {
              if (process.env.JSII_DEBUG !== "1" && error.name === "DeprecationError") {
                  Error.captureStackTrace(error, Foo);
              }
              throw error;
          } }
      }
      exports.Foo = Foo;"
    `);
  });
});

describe('thrown exceptions have the expected stack trace', () => {
  test('constructor', () => {
    const compilation = compileJsiiForTest(
      `
      /** @deprecated for testing */
      export class DeprecatedConstructor {
        public constructor() {}
      }

      function test() {
        new DeprecatedConstructor();
      }

      test();
    `,
      undefined,
      { addDeprecationWarnings: true },
    );
    const source = jsFile(compilation);

    const context = createVmContext(compilation);
    try {
      vm.runInContext(source, context, { filename: 'index.js' });
      // The above line should have resulted in a DeprecationError being thrown
      expect(null).toBeInstanceOf(Error);
    } catch (error: any) {
      expect(error.stack.replace(process.cwd(), '<process.cwd>')).toMatchInlineSnapshot(`
        "index.js:16
                throw error;
                ^

        DeprecationError: testpkg.DeprecatedConstructor is deprecated, and will be removed in the next major release.
         for testing
            at test (index.js:21:5)
            at index.js:23:1"
      `);
    }
  });

  test('multiple calls for the same element only get reported once', () => {
    const compilation = compileJsiiForTest(
      `
      /** @deprecated for testing */
      export class DeprecatedConstructor {
        public constructor() {}
      }

      function test() {
        new DeprecatedConstructor();
      }

      test();
      test();
    `,
      undefined,
      { addDeprecationWarnings: true },
    );

    const printed = new Array<string>();

    runJsiiCode(compilation, 'warn', {
      console: {
        warn: (...args: unknown[]) => printed.push(args.join(' ')),
      },
    });

    // The deprecated constructor is called twice, and reported once.
    expect(printed).toEqual([expect.stringContaining('DeprecatedConstructor is deprecated')]);
  });

  test('getter', () => {
    const compilation = compileJsiiForTest(
      `
      export class DeprecatedConstructor {
        /** @deprecated for testing */
        public get property() {
          return 1337;
        }
      }

      function test() {
        const subject = new DeprecatedConstructor();
        return subject.property;
      }

      test();
    `,
      undefined,
      { addDeprecationWarnings: true },
    );
    const source = jsFile(compilation);

    const context = createVmContext(compilation);
    try {
      vm.runInContext(source, context, { filename: 'index.js' });
      // The above line should have resulted in a DeprecationError being thrown
      expect(null).toBeInstanceOf(Error);
    } catch (error: any) {
      expect(error.stack.replace(process.cwd(), '<process.cwd>')).toMatchInlineSnapshot(`
        "index.js:17
                    throw error;
                    ^

        DeprecationError: testpkg.DeprecatedConstructor#property is deprecated, and will be removed in the next major release.
         for testing
            at test (index.js:25:20)
            at index.js:27:1"
      `);
    }
  });

  test('setter', () => {
    const compilation = compileJsiiForTest(
      `
      export class DeprecatedConstructor {
        private value = 1337;

        /** @deprecated for testing */
        public get property(): number {
          return this.value;
        }

        public set property(value: number) {
          this.value = value;
        }
      }

      function test() {
        const subject = new DeprecatedConstructor();
        subject.property = 42;
      }

      test();
    `,
      undefined,
      { addDeprecationWarnings: true },
    );
    const source = jsFile(compilation);

    const context = createVmContext(compilation);
    try {
      vm.runInContext(source, context, { filename: 'index.js' });
      // The above line should have resulted in a DeprecationError being thrown
      expect(null).toBeInstanceOf(Error);
    } catch (error: any) {
      expect(error.stack.replace(process.cwd(), '<process.cwd>')).toMatchInlineSnapshot(`
        "index.js:30
                    throw error;
                    ^

        DeprecationError: testpkg.DeprecatedConstructor#property is deprecated, and will be removed in the next major release.
         for testing
            at test (index.js:38:22)
            at index.js:40:1"
      `);
    }
  });

  test('method', () => {
    const compilation = compileJsiiForTest(
      `
      export class DeprecatedConstructor {
        /** @deprecated for testing */
        public deprecated(): void {
          // Nothing to do
        }
      }

      function test() {
        const subject = new DeprecatedConstructor();
        subject.deprecated();
      }

      test();
    `,
      undefined,
      { addDeprecationWarnings: true },
    );
    const source = jsFile(compilation);

    const context = createVmContext(compilation);
    try {
      vm.runInContext(source, context, { filename: 'index.js' });
      // The above line should have resulted in a DeprecationError being thrown
      expect(null).toBeInstanceOf(Error);
    } catch (error: any) {
      expect(error.stack.replace(process.cwd(), '<process.cwd>')).toMatchInlineSnapshot(`
        "index.js:17
                    throw error;
                    ^

        DeprecationError: testpkg.DeprecatedConstructor#deprecated is deprecated, and will be removed in the next major release.
         for testing
            at test (index.js:24:13)
            at index.js:26:1"
      `);
    }
  });
});

function jsFile(result: HelperCompilationResult, baseName = 'index'): string {
  const file = Object.entries(result.files).find(([name]) => name === `${baseName}.js`);

  if (!file) {
    throw new Error(`Could not find file with base name: ${baseName}`);
  }

  return file[1];
}

/** Drops the trailing inline source map, which these tests do not care about. */
function withoutSourceMap(js: string): string {
  return js.replace(/\n\/\/# sourceMappingURL=.*$/, '');
}

function jsFunction(result: HelperCompilationResult, functionName: string, baseName = 'index'): string {
  const contents = jsFile(result, baseName);
  return extractFunction(contents, functionName);
}

function extractFunction(contents: string, functionName: string): string {
  const needle = `function ${functionName}(p) {`;
  const startIndex = contents.indexOf(needle);
  if (startIndex < 0) {
    throw new Error(
      `Could not find 'function ${functionName}(p) {' in:\n------------------------------\n${contents}\n------------------------------`,
    );
  }

  let curlies = 1;
  let i = startIndex + needle.length;
  for (; i < contents.length && curlies > 0; i++) {
    switch (contents[i]) {
      case '{':
        curlies += 1;
        break;
      case '}':
        curlies -= 1;
        break;
      default:
        break;
    }
  }
  const endIndex = i;

  return contents.slice(startIndex, endIndex + 1);
}

function createVmContext(
  compilation: HelperCompilationResult,
  deprecationBehavior: 'fail' | 'warn' = 'fail',
  additionalContext: Record<string, unknown> = {},
) {
  const context = vm.createContext({
    exports: {},
    process: {
      env: {
        JSII_DEPRECATED: deprecationBehavior,
      },
    },
    // Bringing in a "fake" require(id) function that'll resolve relative paths
    // to files within the compilation output, and module names using the
    // regular require. When loading a file that was part of the compiler output,
    // this emulates the situation that would be if the file had been through a
    // bundler by turning all sequences of white spaces (new line included) into
    // single spaces.
    require: (id: string) => {
      if (!id.startsWith('./')) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require(id);
      }
      const code = jsFile(compilation, path.basename(id, '.js'))
        // Pretend this has been webpack'd
        .replace(/\s+/gm, ' ');
      return vm.runInContext(
        `(function(module){
          {
            ${code}
          }
          return module.exports;
        })({ exports: {} });`,
        context,
        { filename: id, lineOffset: -2, columnOffset: -4 },
      );
    },
    ...additionalContext,
  });

  // Limit error stack traces to 2 frames... We don't need more for the sake of this test. This is
  // important because past 2 levels, the stack frames will have entries that will be different on
  // different versions of node, and that'll break our unit tests...
  vm.runInContext('Error.stackTraceLimit = 2;', context);

  return context;
}

function loadWarningsFile(projectRoot: string) {
  return fs.readFileSync(path.join(projectRoot, '.warnings.jsii.js')).toString();
}

function runJsiiCode(
  compilation: HelperCompilationResult,
  deprecationBehavior: 'fail' | 'warn' = 'fail',
  additionalContext: Record<string, unknown> = {},
) {
  const source = jsFile(compilation);
  const context = createVmContext(compilation, deprecationBehavior, additionalContext);
  vm.runInContext(source, context, { filename: 'index.js' });
}
