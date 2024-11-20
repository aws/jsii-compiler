import { DiagnosticCategory } from 'typescript';

import { Code, configureCategories } from '../src/jsii-diagnostic';

describe('jsii diagnostics', () => {
  describe('configureCategories', () => {
    beforeEach(() => {
      const code = Code.lookup(1)!;
      code.category = DiagnosticCategory.Suggestion;
    });

    test('prototype pollution', () => {
      const pollution = JSON.parse('{"__proto__":{"pollutedKey":123}}');
      expect(({ foo: 'bar' } as any).category).toBeUndefined();
      expect(() => configureCategories(pollution as any)).toThrow(`Unrecognized diagnostic code '__proto__'`);
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
});
