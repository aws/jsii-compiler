import * as ts from 'typescript';
import { JsiiDiagnostic } from '../src';
import { Directives } from '../src/directives';
import { formatDiagnostic, stripAnsi } from '../src/utils';

test('non-directive tags', () => {
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
  const directives = Directives.of(ctorDecl, unexpectedDiagnostic);

  // Then
  expect(directives.tsInternal).toBeFalsy();
  expect(directives.ignore).toBeFalsy();
});

describe('@internal', () => {
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
    const directives = Directives.of(classDecl, unexpectedDiagnostic);

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
    const directives = Directives.of(ctorDecl, unexpectedDiagnostic);

    // Then
    expect(directives.tsInternal).toBeFalsy();
    expect(directives.ignore).toBeFalsy();
  });
});

describe('@jsii', () => {
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
        "test.ts:1:5 - warning JSII2000: Missing argument to @jsii directive. Refer to the jsii compiler documentation for more information.

        1 /** @jsii */ export class Internal { public constructor() {} }
              ~~~~~~

        "
      `);
      hadDiagnostic = true;
    };

    // When
    const directives = Directives.of(classDecl, onDiagnostic);

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
        "test.ts:1:5 - warning JSII2999: Unknown @jsii directive: "absolutely-not-a-directive". Refer to the jsii compiler documentation for more information.

        1 /** @jsii absolutely-not-a-directive */ export class Internal { public constructor() {} }
              ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

        "
      `);
      hadDiagnostic = true;
    };

    // When
    const directives = Directives.of(classDecl, onDiagnostic);

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
        "test.ts:2:10 - warning JSII2999: Unknown @jsii directive: "absolutely-not-a-directive". Refer to the jsii compiler documentation for more information.

        2        * @jsii absolutely-not-a-directive
                   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
        3        * @jsii ignore
          ~~~~~~~~~

        "
      `);
      hadDiagnostic = true;
    };

    // When
    const directives = Directives.of(classDecl, onDiagnostic);

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
        "test.ts:2:10 - warning JSII2999: Unknown @jsii directive: "absolutely-not-a-directive". Refer to the jsii compiler documentation for more information.

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
    const directives = Directives.of(classDecl, onDiagnostic);

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
    const directives = Directives.of(classDecl, unexpectedDiagnostic);

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
    const directives = Directives.of(indexSignature, unexpectedDiagnostic);

    // Then
    expect(directives.tsInternal).toBeFalsy();
    expect(directives.ignore).toBeTruthy();
  });
});

function unexpectedDiagnostic(diag: JsiiDiagnostic) {
  const formatted = formatDiagnostic(diag, __dirname);
  // Always causes an assertion error
  expect(stripAnsi(formatted)).toBeUndefined();
}
