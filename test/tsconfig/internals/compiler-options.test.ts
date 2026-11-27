import {
  BASE_COMPILER_OPTIONS,
  convertForJson,
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

describe('convertForJson', () => {
  // The TypeScript 7 parser's form: enum values as numbers, `lib` as file names.
  const parsed = {
    target: 99,
    module: 199,
    moduleResolution: 2,
    jsx: 4,
    newLine: 2,
    lib: ['lib.es2022.d.ts'],
    strict: true,
  };

  test('names the values like the classic compiler, including its wrong names', () => {
    expect(convertForJson(parsed)).toEqual({
      target: 'latest',
      module: 'nodenext',
      moduleResolution: 'node10',
      jsx: 'react-js-x',
      newLine: 'lf',
      lib: ['es2022'],
      strict: true,
    });
    expect(convertForJson({ target: 1 }).target).toBe('es5');
  });

  test('keeps values that are already in the JSON form', () => {
    expect(convertForJson(BASE_COMPILER_OPTIONS)).toEqual(BASE_COMPILER_OPTIONS);
  });
});
