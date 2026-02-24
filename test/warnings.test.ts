import { DiagnosticCategory } from 'typescript';

import { compileJsiiForTest } from '../src';
import { Code, JsiiDiagnostic } from '../src/jsii-diagnostic';
import { isSilenced, parseWarningCodes, silencedWarnings } from '../src/warnings';

beforeEach(() => {
  silencedWarnings.clear();
});

describe('parseWarningCodes', () => {
  test('parses JSII code format', () => {
    expect(parseWarningCodes('JSII5018')).toEqual([5018]);
  });

  test('parses JSII code format case-insensitively', () => {
    expect(parseWarningCodes('jsii5018')).toEqual([5018]);
  });

  test('parses plain number', () => {
    expect(parseWarningCodes('5018')).toEqual([5018]);
  });

  test('parses full diagnostic name', () => {
    expect(parseWarningCodes('language-compatibility/reserved-word')).toEqual([5018]);
  });

  test('parses specific name (after slash)', () => {
    const codes = parseWarningCodes('reserved-word');
    expect(codes).toContain(5018);
  });

  test('parses category name and returns all matching codes', () => {
    const codes = parseWarningCodes('language-compatibility');
    expect(codes.length).toBeGreaterThan(1);
    expect(codes).toContain(5018); // reserved-word
    expect(codes).toContain(5019); // member-name-conflicts-with-type-name
  });

  test('throws on unknown name', () => {
    expect(() => parseWarningCodes('does-not-exist')).toThrow(/Unknown warning "does-not-exist"/);
  });

  test('throws on unknown full name', () => {
    expect(() => parseWarningCodes('fake-category/fake-name')).toThrow(/Unknown warning/);
  });
});

describe('Code.lookupByPartialName', () => {
  test('exact full name match', () => {
    const results = Code.lookupByPartialName('language-compatibility/reserved-word');
    expect(results).toHaveLength(1);
    expect(results[0].code).toBe(5018);
  });

  test('no match for unknown full name', () => {
    expect(Code.lookupByPartialName('fake/name')).toHaveLength(0);
  });

  test('matches by category', () => {
    const results = Code.lookupByPartialName('language-compatibility');
    expect(results.length).toBeGreaterThan(1);
    expect(results.every((c) => c.name.startsWith('language-compatibility/'))).toBe(true);
  });

  test('matches by specific name', () => {
    const results = Code.lookupByPartialName('reserved-word');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('language-compatibility/reserved-word');
  });

  test('no match for unknown partial name', () => {
    expect(Code.lookupByPartialName('nonexistent')).toHaveLength(0);
  });
});

describe('isSilenced', () => {
  test('returns false when nothing is silenced', () => {
    const diag = JsiiDiagnostic.JSII_5018_RESERVED_WORD.createDetached('test', ['Python']);
    expect(isSilenced(diag)).toBe(false);
  });

  test('returns true for a silenced warning', () => {
    silencedWarnings.add(5018);
    const diag = JsiiDiagnostic.JSII_5018_RESERVED_WORD.createDetached('test', ['Python']);
    expect(isSilenced(diag)).toBe(true);
  });

  test('returns false for a non-silenced warning', () => {
    silencedWarnings.add(5019);
    const diag = JsiiDiagnostic.JSII_5018_RESERVED_WORD.createDetached('test', ['Python']);
    expect(isSilenced(diag)).toBe(false);
  });

  test('returns false for errors even if code is silenced', () => {
    silencedWarnings.add(5020);
    const diag = JsiiDiagnostic.JSII_5020_STATIC_MEMBER_CONFLICTS_WITH_NESTED_TYPE.createDetached(
      { kind: 'class', name: 'Foo', fqn: 'test.Foo', assembly: 'test' } as any,
      { name: 'bar' } as any,
      { kind: 'class', name: 'Bar', fqn: 'test.Bar', assembly: 'test' } as any,
    );
    expect(diag.category).toBe(DiagnosticCategory.Error);
    expect(isSilenced(diag)).toBe(false);
  });

  test('returns false for non-jsii diagnostics', () => {
    silencedWarnings.add(1234);
    const diag = {
      category: DiagnosticCategory.Warning,
      code: 1234,
      file: undefined,
      start: undefined,
      length: undefined,
      messageText: 'test',
    };
    expect(isSilenced(diag)).toBe(false);
  });
});

describe('silencing integration', () => {
  afterEach(() => {
    silencedWarnings.clear();
  });

  test('silenced warnings are still in diagnostics', () => {
    silencedWarnings.add(5018);
    const result = compileJsiiForTest(
      `
      export class None {
        public do(_internal: boolean): void { /* noop */ }
      }
    `,
      { captureDiagnostics: true },
    );
    // The warning is still emitted in the diagnostics
    const warnings = result.diagnostics.filter((d) => d.category === DiagnosticCategory.Warning);
    expect(warnings.some((d) => JsiiDiagnostic.isJsiiDiagnostic(d) && d.jsiiCode === 5018)).toBe(true);
  });

  test('silenced warnings do not cause failure with failOnWarnings', () => {
    silencedWarnings.add(5018);
    silencedWarnings.add(3); // missing-readme
    const result = compileJsiiForTest(
      `
      export class None {
        public do(_internal: boolean): void { /* noop */ }
      }
    `,
      { captureDiagnostics: true },
      { failOnWarnings: true },
    );
    // Should succeed because all warnings are silenced
    expect(result.type).toBe('success');
  });

  test('non-silenced warnings still cause failure with failOnWarnings', () => {
    // Only silence missing-readme, not reserved-word
    silencedWarnings.add(3);
    const result = compileJsiiForTest(
      `
      export class None {
        public do(_internal: boolean): void { /* noop */ }
      }
    `,
      { captureDiagnostics: true },
      { failOnWarnings: true },
    );
    expect(result.type).toBe('failure');
  });
});
