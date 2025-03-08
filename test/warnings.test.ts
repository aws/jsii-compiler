import { DiagnosticCategory } from 'typescript';
import { Code, JsiiDiagnostic } from '../src/jsii-diagnostic';
import { JsiiError } from '../src/utils';
import { enabledWarnings, silenceWarnings } from '../src/warnings';

describe('enabledWarnings', () => {
  test('contains all available Jsii warnings', () => {
    const definedWarnings = Object.keys(JsiiDiagnostic).reduce((warnings, warningKey) => {
      const code = JsiiDiagnostic[warningKey as keyof typeof JsiiDiagnostic];
      if (code instanceof Code && code.category === DiagnosticCategory.Warning) {
        warnings[code.name] = true;
      }
      return warnings;
    }, {} as { [name: string]: boolean });

    expect(enabledWarnings).toStrictEqual(definedWarnings);
  });
});

describe('silenceWarnings', () => {
  test('sets enabledWarnings key to false', () => {
    expect(enabledWarnings['metadata/missing-readme']).toBe(true);
    silenceWarnings(['metadata/missing-readme']);
    expect(enabledWarnings['metadata/missing-readme']).toBe(false);
  });

  test('translates legacy key to current Code.name', () => {
    expect(enabledWarnings['language-compatibility/reserved-word']).toBe(true);
    silenceWarnings(['reserved-word']);
    expect(enabledWarnings['language-compatibility/reserved-word']).toBe(false);
  });

  test('throws when key is not valid', () => {
    expect(() => silenceWarnings(['invalid-warning'])).toThrow(JsiiError);
  });
});
