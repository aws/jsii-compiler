import * as ts from 'typescript';
import {
  convertForJson,
  convertJsxForJson,
  convertScriptTargetForJson,
  enumAsCamel,
  enumAsKebab,
  enumAsLower,
} from '../../../src/tsconfig/compiler-options';
enum Sample {
  None = 0,
  FirstValue = 1,
  SECOND = 2,
  ThirdValueHere = 3,
}

describe('enum helpers', () => {
  test('enumAsCamel lists the member names in camel case, skipping reverse mappings', () => {
    expect(enumAsCamel(Sample)).toEqual(['none', 'firstValue', 'second', 'thirdValueHere']);
  });

  test('enumAsLower lists the member names in lower case, skipping reverse mappings and "None"', () => {
    expect(enumAsLower(Sample)).toEqual(['firstvalue', 'second', 'thirdvaluehere']);
  });

  test('enumAsKebab lists the member names in kebab case, skipping reverse mappings and "None"', () => {
    expect(enumAsKebab(Sample)).toEqual(['first-value', 'second', 'third-value-here']);
  });

  test('works for string enums', () => {
    const stringEnum = { Alpha: 'alpha', BetaGamma: 'beta-gamma' };

    expect(enumAsCamel(stringEnum)).toEqual(['alpha', 'betaGamma']);
    expect(enumAsLower(stringEnum)).toEqual(['alpha', 'betagamma']);
    expect(enumAsKebab(stringEnum)).toEqual(['alpha', 'beta-gamma']);
  });
});

describe('convertJsxForJson', () => {
  test('maps every JsxEmit value to its tsconfig spelling', () => {
    const cases: Array<[ts.JsxEmit, string]> = [
      [ts.JsxEmit.None, 'none'],
      [ts.JsxEmit.Preserve, 'preserve'],
      [ts.JsxEmit.React, 'react'],
      [ts.JsxEmit.ReactNative, 'react-native'],
      [ts.JsxEmit.ReactJSX, 'react-jsx'],
      [ts.JsxEmit.ReactJSXDev, 'react-jsxdev'],
    ];
    for (const [jsx, expected] of cases) {
      expect(convertJsxForJson(jsx)).toBe(expected);
    }
  });
});

describe('convertScriptTargetForJson', () => {
  test('maps every ScriptTarget value to its tsconfig spelling', () => {
    const cases: Array<[ts.ScriptTarget, string]> = [
      [ts.ScriptTarget.ES3, 'es3'],
      [ts.ScriptTarget.ES5, 'es5'],
      [ts.ScriptTarget.ES2015, 'es2015'],
      [ts.ScriptTarget.ES2023, 'es2023'],
      [ts.ScriptTarget.ES2024, 'es2024'],
      [ts.ScriptTarget.ESNext, 'esnext'],
      [ts.ScriptTarget.Latest, 'esnext'],
    ];
    for (const [target, expected] of cases) {
      expect(convertScriptTargetForJson(target)).toBe(expected);
    }
  });
});

describe('convertForJson', () => {
  test('writes jsx and target using their tsconfig spellings', () => {
    expect(
      convertForJson({
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ESNext,
      }),
    ).toEqual({ jsx: 'react-jsx', target: 'esnext' });
  });

  test('writes react-jsxdev for the development jsx runtime', () => {
    expect(convertForJson({ jsx: ts.JsxEmit.ReactJSXDev })).toEqual({ jsx: 'react-jsxdev' });
  });
});
