import * as ts from 'typescript';
import { sourceToAssemblyHelper } from '../lib';
import { JsiiDiagnostic } from '../src';
import { compileJsiiForErrors } from './compiler-helpers';
import { formatDiagnostic, stripAnsi } from '../src/utils';

// @TODO(ts7): the `Directives` parser (src/directives.ts) worked on the in-process TypeScript AST, which the
// TypeScript 7 compiler does not hold. `@jsii ignore` is recognized by the assembler from the JSDoc tags the
// TypeScript 7 API returns (tested below); the parser-level tests and the directive diagnostics
// (JSII2000/JSII2999, `@jsii suppress`) are kept here for the port of the validation diagnostics.
// The module is loaded lazily so that this file type-checks and runs while the parser does not exist.
function directivesOf(node: ts.Node, onDiagnostic: (diag: JsiiDiagnostic) => void): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/directives').Directives.of(node, onDiagnostic);
}

test.skip('non-directive tags', () => {
  // Given
  const sourceFile = ts.createSourceFile(
    'test.ts',
    `export class Internal { /** @param param some parameter */ public constructor(public readonly param: unknown) {} }`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const classDecl = sourceFile.statements[0] as ts.ClassDeclaration;
  const ctorDecl = classDecl.members[0];

  // When
  const directives = directivesOf(ctorDecl, unexpectedDiagnostic);

  // Then
  expect(directives.tsInternal).toBeFalsy();
  expect(directives.ignore).toBeFalsy();
});

describe.skip('@internal', () => {
  test('set on declaration', () => {
    // Given
    const sourceFile = ts.createSourceFile(
      'test.ts',
      `/** @internal */ export class Internal { public constructor() {} }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const classDecl = sourceFile.statements[0];

    // When
    const directives = directivesOf(classDecl, unexpectedDiagnostic);

    // Then
    expect(directives.tsInternal).toBeTruthy();
    expect(directives.ignore).toBeFalsy();
  });

  test('set on parent declaration', () => {
    // Given
    const sourceFile = ts.createSourceFile(
      'test.ts',
      `/** @internal */ export class Internal { public constructor() {} }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const classDecl = sourceFile.statements[0] as ts.ClassDeclaration;
    const ctorDecl = classDecl.members[0];

    // When
    const directives = directivesOf(ctorDecl, unexpectedDiagnostic);

    // Then
    expect(directives.tsInternal).toBeFalsy();
    expect(directives.ignore).toBeFalsy();
  });
});

describe.skip('@jsii', () => {
  test('without content', () => {
    // Given
    const sourceFile = ts.createSourceFile(
      'test.ts',
      `/** @jsii */ export class Internal { public constructor() {} }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const classDecl = sourceFile.statements[0];
    let hadDiagnostic = false;
    const onDiagnostic = (diag: JsiiDiagnostic) => {
      expect(hadDiagnostic).toBeFalsy();
      const formatted = formatDiagnostic(diag, __dirname);
      expect(stripAnsi(formatted)).toMatchInlineSnapshot(`
        "test.ts:1:5 - warning JSII2000: Missing argument to @jsii directive. Refer to the jsii compiler documentation for more information. [jsii-directive/missing-argument]

        1 /** @jsii */ export class Internal { public constructor() {} }
              ~~~~~~

        "
      `);
      hadDiagnostic = true;
    };

    // When
    const directives = directivesOf(classDecl, onDiagnostic);

    // Then
    expect(hadDiagnostic).toBeTruthy();
    expect(directives.tsInternal).toBeFalsy();
    expect(directives.ignore).toBeFalsy();
  });

  test('with unknown directive', () => {
    // Given
    const sourceFile = ts.createSourceFile(
      'test.ts',
      `/** @jsii absolutely-not-a-directive */ export class Internal { public constructor() {} }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const classDecl = sourceFile.statements[0];
    let hadDiagnostic = false;
    const onDiagnostic = (diag: JsiiDiagnostic) => {
      expect(hadDiagnostic).toBeFalsy();
      const formatted = formatDiagnostic(diag, __dirname);
      expect(stripAnsi(formatted)).toMatchInlineSnapshot(`
        "test.ts:1:5 - warning JSII2999: Unknown @jsii directive: "absolutely-not-a-directive". Refer to the jsii compiler documentation for more information. [jsii-directive/unknown]

        1 /** @jsii absolutely-not-a-directive */ export class Internal { public constructor() {} }
              ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

        "
      `);
      hadDiagnostic = true;
    };

    // When
    const directives = directivesOf(classDecl, onDiagnostic);

    // Then
    expect(hadDiagnostic).toBeTruthy();
    expect(directives.tsInternal).toBeFalsy();
    expect(directives.ignore).toBeFalsy();
  });

  test('one known, one unknown directive', () => {
    // Given
    const sourceFile = ts.createSourceFile(
      'test.ts',
      `/**
       * @jsii absolutely-not-a-directive
       * @jsii ignore
       */
      export class Ignored { public constructor() {} }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const classDecl = sourceFile.statements[0];
    let hadDiagnostic = false;
    const onDiagnostic = (diag: JsiiDiagnostic) => {
      expect(hadDiagnostic).toBeFalsy();
      const formatted = formatDiagnostic(diag, __dirname);
      expect(stripAnsi(formatted)).toMatchInlineSnapshot(`
        "test.ts:2:10 - warning JSII2999: Unknown @jsii directive: "absolutely-not-a-directive". Refer to the jsii compiler documentation for more information. [jsii-directive/unknown]

        2        * @jsii absolutely-not-a-directive
                   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
        3        * @jsii ignore
          ~~~~~~~~~

        "
      `);
      hadDiagnostic = true;
    };

    // When
    const directives = directivesOf(classDecl, onDiagnostic);

    // Then
    expect(hadDiagnostic).toBeTruthy();
    expect(directives.tsInternal).toBeFalsy();
    expect(directives.ignore).toBeTruthy();
  });

  test('one known, one unknown directive in multi-line style', () => {
    // Given
    const sourceFile = ts.createSourceFile(
      'test.ts',
      `/**
       * @jsii absolutely-not-a-directive
       *       ignore
       */
      export class Ignored { public constructor() {} }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const classDecl = sourceFile.statements[0];
    let hadDiagnostic = false;
    const onDiagnostic = (diag: JsiiDiagnostic) => {
      expect(hadDiagnostic).toBeFalsy();
      const formatted = formatDiagnostic(diag, __dirname);
      expect(stripAnsi(formatted)).toMatchInlineSnapshot(`
        "test.ts:2:10 - warning JSII2999: Unknown @jsii directive: "absolutely-not-a-directive". Refer to the jsii compiler documentation for more information. [jsii-directive/unknown]

        2        * @jsii absolutely-not-a-directive
                   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
        3        *       ignore
          ~~~~~~~~~~~~~~~~~~~~~
        4        */
          ~~~~~~~

        "
      `);
      hadDiagnostic = true;
    };

    // When
    const directives = directivesOf(classDecl, onDiagnostic);

    // Then
    expect(hadDiagnostic).toBeTruthy();
    expect(directives.tsInternal).toBeFalsy();
    expect(directives.ignore).toBeTruthy();
  });

  test('ignore declaration', () => {
    // Given
    const sourceFile = ts.createSourceFile(
      'test.ts',
      `/** @jsii ignore */ export class Ignored { public constructor() {} }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const classDecl = sourceFile.statements[0];

    // When
    const directives = directivesOf(classDecl, unexpectedDiagnostic);

    // Then
    expect(directives.tsInternal).toBeFalsy();
    expect(directives.ignore).toBeTruthy();
  });

  test('ignore declaration on index signature', () => {
    // Given
    const sourceFile = ts.createSourceFile(
      'test.ts',
      `export class Ignored {
        public constructor() {}
        /** @jsii ignore */
        [key: string]: unknown;
      }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const classDecl = sourceFile.statements[0] as ts.ClassDeclaration;
    const indexSignature = classDecl.members[1];

    // When
    const directives = directivesOf(indexSignature, unexpectedDiagnostic);

    // Then
    expect(directives.tsInternal).toBeFalsy();
    expect(directives.ignore).toBeTruthy();
  });

  test('suppress directive', () => {
    // Given
    const sourceFile = ts.createSourceFile(
      'test.ts',
      `export class Foo {
        public constructor() {}
        /** @jsii suppress JSII5019 this name is intentional */
        public foo(): void {}
      }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const classDecl = sourceFile.statements[0] as ts.ClassDeclaration;
    const methodDecl = classDecl.members[1];

    // When
    const directives = directivesOf(methodDecl, unexpectedDiagnostic);

    // Then
    expect(directives.suppressions).toEqual(['JSII5019']);
  });

  test('multiple suppress directives', () => {
    // Given
    const sourceFile = ts.createSourceFile(
      'test.ts',
      `export class Foo {
        public constructor() {}
        /**
         * @jsii suppress JSII5018
         * @jsii suppress JSII5019
         */
        public foo(): void {}
      }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const classDecl = sourceFile.statements[0] as ts.ClassDeclaration;
    const methodDecl = classDecl.members[1];

    // When
    const directives = directivesOf(methodDecl, unexpectedDiagnostic);

    // Then
    expect(directives.suppressions).toEqual(['JSII5018', 'JSII5019']);
  });
});

describe('@jsii ignore', () => {
  // @TODO(ts7): expects a jsii validation diagnostic (JSII3004); re-enable with the port of the validator
  test.skip('without an ignore directive, extending a mapped type emits JSII3004', () => {
    const errors = compileJsiiForErrors(`
      export interface Base {
        readonly foo: string;
      }
      export interface Derived extends Partial<Base> {
        readonly baz: number;
      }
    `);
    expect(errors).toEqual([expect.stringMatching(/Illegal extends clause.*MappedType/)]);
  });

  test('an interface extending a mapped type does not emit an error when ignored', () => {
    const errors = compileJsiiForErrors(`
      export interface Base {
        readonly foo: string;
      }

      /** @jsii ignore */
      export interface Derived extends Partial<Base> {
        readonly baz: number;
      }
    `);
    expect(errors).toEqual([]);
  });

  test('a class extending a mapped type does not emit an error when ignored', () => {
    const errors = compileJsiiForErrors(`
      export interface Base {
        readonly foo: string;
        readonly bar: string;
      }

      /** @jsii ignore */
      export class Impl implements Partial<Base> {
        public readonly foo?: string;
      }
    `);
    expect(errors).toEqual([]);
  });

  test('an ignored interface is excluded from the assembly', () => {
    const assembly = sourceToAssemblyHelper(`
      export interface Base {
        readonly foo: string;
      }

      /** @jsii ignore */
      export interface Derived extends Partial<Base> {
        readonly baz: number;
      }
    `);

    // The ignored declaration is invisible to other languages...
    expect(assembly.types!['testpkg.Derived']).toBeUndefined();
    // ...while the rest of the API is still emitted.
    expect(assembly.types!['testpkg.Base']).toBeDefined();
  });

  test('an ignored class is excluded from the assembly', () => {
    const assembly = sourceToAssemblyHelper(`
      export interface Base {
        readonly foo: string;
        readonly bar: string;
      }

      /** @jsii ignore */
      export class Impl implements Partial<Base> {
        public readonly foo?: string;
      }
    `);

    expect(assembly.types!['testpkg.Impl']).toBeUndefined();
    expect(assembly.types!['testpkg.Base']).toBeDefined();
  });

  test('an ignored member is excluded from its type', () => {
    const assembly = sourceToAssemblyHelper(`
      export class Thing {
        public readonly visible: string = 'x';

        /** @jsii ignore */
        public readonly hidden: string = 'y';
      }
    `);

    const properties = (assembly.types!['testpkg.Thing'] as any).properties ?? [];
    const names = properties.map((p: any) => p.name);
    expect(names).toContain('visible');
    expect(names).not.toContain('hidden');
  });

  // @TODO(ts7): expects a jsii validation diagnostic (JSII3xxx); re-enable with the port of the validator
  test.skip('an ignored type is effectively private and cannot be exposed on the public API', () => {
    const errors = compileJsiiForErrors(`
      /** @jsii ignore */
      export interface Hidden {
        readonly foo: string;
      }

      export class Api {
        public give(): Hidden {
          return { foo: 'x' };
        }
      }
    `);

    expect(errors).toContainEqual(
      expect.stringContaining('cannot be used as the return type because it is private or @internal'),
    );
  });

  // The directive is honored on any exported declaration, not just classes and
  // interfaces. An ignored enum is dropped from the assembly entirely.
  test('an ignored enum is excluded from the assembly', () => {
    const assembly = sourceToAssemblyHelper(`
      /** @jsii ignore */
      export enum Hidden {
        A,
        B,
      }

      export enum Visible {
        A,
        B,
      }
    `);

    expect(assembly.types!['testpkg.Hidden']).toBeUndefined();
    expect(assembly.types!['testpkg.Visible']).toBeDefined();
  });

  // Ignoring a namespace (submodule) ignores everything nested within it, since
  // jsii never descends into an ignored declaration.
  test('an ignored namespace excludes all of its nested declarations', () => {
    const assembly = sourceToAssemblyHelper(`
      /** @jsii ignore */
      export namespace hidden {
        export interface Inner {
          readonly foo: string;
        }
      }

      export interface Top {
        readonly bar: string;
      }
    `);

    expect(assembly.types!['testpkg.hidden.Inner']).toBeUndefined();
    expect(assembly.types!['testpkg.Top']).toBeDefined();
  });

  // A symbol is only ignored when *every* one of its (merged) declarations is
  // marked. This keeps emission consistent with reference resolution: a type
  // with one un-ignored declaration is still part of the public API.
  test('a merged declaration is kept when only some declarations are ignored', () => {
    const assembly = sourceToAssemblyHelper(`
      /** @jsii ignore */
      export interface Merged {
        readonly a: string;
      }
      export interface Merged {
        readonly b: string;
      }
    `);

    expect(assembly.types!['testpkg.Merged']).toBeDefined();
  });

  test('a merged declaration is excluded only when every declaration is ignored', () => {
    const assembly = sourceToAssemblyHelper(`
      /** @jsii ignore */
      export interface Merged {
        readonly a: string;
      }
      /** @jsii ignore */
      export interface Merged {
        readonly b: string;
      }

      export interface Keep {
        readonly c: string;
      }
    `);

    expect(assembly.types!['testpkg.Merged']).toBeUndefined();
    expect(assembly.types!['testpkg.Keep']).toBeDefined();
  });
});

function unexpectedDiagnostic(diag: JsiiDiagnostic) {
  const formatted = formatDiagnostic(diag, __dirname);
  // Always causes an assertion error
  expect(stripAnsi(formatted)).toBeUndefined();
}
