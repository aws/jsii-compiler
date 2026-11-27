import * as ts from 'typescript';
import { DiagnosticCategory } from 'typescript';

import { Code, configureCategories, JsiiDiagnostic } from '../src';

describe('jsii diagnostics', () => {
  describe('configureCategories', () => {
    beforeEach(() => {
      const code = Code.lookup(1)!;
      code.category = DiagnosticCategory.Suggestion;
    });

    test('throws on __proto__ key', () => {
      expect(() => configureCategories(JSON.parse('{"__proto__":{"pollutedKey":123}}'))).toThrow(
        `Unrecognized diagnostic code '__proto__'`,
      );
    });

    test('diagnostic by name', () => {
      configureCategories({
        'metadata/package-json-missing-description': DiagnosticCategory.Error,
      });
      expect(Code.lookup(1)!.category).toEqual(DiagnosticCategory.Error);
    });

    test('diagnostic by code', () => {
      configureCategories({
        JSII1: DiagnosticCategory.Error,
      });
      expect(Code.lookup(1)!.category).toEqual(DiagnosticCategory.Error);
    });

    test('diagnostic by code zero prefixed', () => {
      configureCategories({
        JSII001: DiagnosticCategory.Error,
      });
      expect(Code.lookup(1)!.category).toEqual(DiagnosticCategory.Error);
    });

    test('invalid diagnostic code - NaN', () => {
      expect(() => {
        configureCategories({
          JSIIPP: DiagnosticCategory.Error,
        });
      }).toThrow(/number must follow code/);
    });

    test('invalid diagnostic code - number', () => {
      expect(() => {
        configureCategories({
          JSII77778888: DiagnosticCategory.Error,
        });
      }).toThrow(/Unrecognized diagnostic code/);
    });

    test('invalid diagnostic code - string', () => {
      expect(() => {
        configureCategories({
          'invalid/does-not-exist': DiagnosticCategory.Error,
        });
      }).toThrow(/Unrecognized diagnostic code/);
    });
  });

  describe('Code', () => {
    test('can be looked up by code and by name', () => {
      const code = Code.lookup('metadata/package-json-missing-description');

      expect(code).toBeDefined();
      expect(Code.lookup(1)).toBe(code);
    });

    test('lookup of an unknown code or name is undefined', () => {
      expect(Code.lookup(123456)).toBeUndefined();
      expect(Code.lookup('does-not/exist')).toBeUndefined();
    });

    test('lookupByPartialName finds a diagnostic by its full name', () => {
      expect(Code.lookupByPartialName('metadata/missing-readme')).toEqual([Code.lookup(3)]);
      expect(Code.lookupByPartialName('metadata/does-not-exist')).toEqual([]);
    });

    test('lookupByPartialName finds diagnostics by category or by specific name', () => {
      expect(Code.lookupByPartialName('metadata')).toEqual(expect.arrayContaining([Code.lookup(1), Code.lookup(3)]));
      expect(Code.lookupByPartialName('missing-readme')).toEqual([Code.lookup(3)]);
      expect(Code.lookupByPartialName('does-not-exist')).toEqual([]);
    });

    test('the category of an error cannot be lowered', () => {
      const error = Code.lookup(1000)!;
      expect(error.isError).toBe(true);

      expect(() => {
        error.category = DiagnosticCategory.Warning;
      }).toThrow('Illegal attempt to override category of error 1000 to Warning');
      expect(() => configureCategories({ JSII1000: DiagnosticCategory.Suggestion })).toThrow(
        'Illegal attempt to override category of error 1000 to Suggestion',
      );
      expect(error.category).toBe(DiagnosticCategory.Error);
    });

    test('the category of a non-error can be raised and lowered', () => {
      const code = Code.lookup(1)!;
      const original = code.category;
      try {
        code.category = DiagnosticCategory.Error;
        expect(code.category).toBe(DiagnosticCategory.Error);
        code.category = DiagnosticCategory.Message;
        expect(code.category).toBe(DiagnosticCategory.Message);
      } finally {
        code.category = original;
      }
    });

    describe('registration of duplicates', () => {
      // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2947
      // The constructor checks `code in Code.byCode` (a Map), which is never true, so duplicates are silently accepted
      // and replace the previously registered diagnostic.
      test('a duplicate code or name is accepted and replaces the previous registration', () => {
        const first = Code.error({ code: 987001, name: 'test-only/duplicate', formatter: () => 'first' });
        const duplicate = Code.error({ code: 987001, name: 'test-only/duplicate', formatter: () => 'second' });

        expect(duplicate).not.toBe(first);
        expect(Code.lookup(987001)).toBe(duplicate);
        expect(Code.lookup('test-only/duplicate')).toBe(duplicate);
      });

      // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2947
      // The name is looked up with `in` on a Map, so only the names of properties of the Map are rejected.
      test('a name that is a property of the registry is rejected', () => {
        expect(() => Code.error({ code: 987002, name: 'size', formatter: () => 'x' })).toThrow(
          'Attempted to create two instances of Code with name size',
        );
      });
    });
  });

  describe('JsiiDiagnostic', () => {
    const detached = () => JsiiDiagnostic.JSII_0001_PKG_MISSING_DESCRIPTION.createDetached();

    describe('format', () => {
      // Removes the colors, which are only added when the output is a terminal
      const plain = (text: string) => text.replace(/\u001b\[[\d;]*m/g, '');

      test('shows the code and the name of the diagnostic', () => {
        const formatted = plain(JsiiDiagnostic.JSII_0003_MISSING_README.createDetached().format(process.cwd()));

        expect(formatted).toContain('JSII0003: There is no "README.md" file.');
        expect(formatted).toContain('[metadata/missing-readme]');
      });

      test('does not show a name for a code that is not registered', () => {
        const unregistered = JsiiDiagnostic.JSII_0003_MISSING_README.createDetached();
        (unregistered as { jsiiCode: number }).jsiiCode = 99999;

        const formatted = plain(unregistered.format(process.cwd()));

        expect(formatted).toContain('JSII99999:');
        expect(formatted).not.toContain('[');
      });
    });

    test('can be recognized with isJsiiDiagnostic', () => {
      expect(JsiiDiagnostic.isJsiiDiagnostic(detached())).toBe(true);
      expect(JsiiDiagnostic.isJsiiDiagnostic({ category: 1, code: 1, file: undefined } as ts.Diagnostic)).toBe(false);
    });

    test('addRelatedInformationIf ignores an undefined node', () => {
      const diagnostic = detached();

      expect(diagnostic.addRelatedInformationIf(undefined, 'ignored')).toBe(diagnostic);
      expect(diagnostic.relatedInformation).toEqual([]);
    });

    test('maybeAddRelatedInformation ignores an undefined node', () => {
      const diagnostic = detached();

      expect(diagnostic.maybeAddRelatedInformation(undefined, 'ignored')).toBe(diagnostic);
      expect(diagnostic.relatedInformation).toEqual([]);
    });

    test('maybeAddRelatedInformation adds related information for a node', () => {
      const source = ts.createSourceFile('index.ts', 'export class Klass {}', ts.ScriptTarget.Latest, true);
      const diagnostic = detached();

      diagnostic.maybeAddRelatedInformation(source.statements[0], 'the class is here');

      expect(diagnostic.relatedInformation).toEqual([
        expect.objectContaining({ messageText: 'the class is here', jsiiCode: 9999 }),
      ]);
    });

    test('addRelatedInformation does not point into the TypeScript standard library', () => {
      const lib = ts.createSourceFile(
        '/node_modules/typescript/lib/lib.es5.d.ts',
        'interface Array<T> {}',
        ts.ScriptTarget.Latest,
        true,
      );
      const diagnostic = detached();

      diagnostic.addRelatedInformation(lib.statements[0], 'from the standard library');

      expect(diagnostic.relatedInformation).toEqual([]);
    });

    test('JSII3004 describes an unexpected heritage clause token by its syntax kind', () => {
      const diagnostic = JsiiDiagnostic.JSII_3004_INVALID_SUPERTYPE.createDetached({
        token: ts.SyntaxKind.Identifier,
      } as unknown as ts.HeritageClause);

      expect(diagnostic.messageText).toBe('Illegal Identifier clause for an exported API: unnamed base type');
    });
  });
});
