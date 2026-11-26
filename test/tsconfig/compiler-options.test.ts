import { enumAsCamel, enumAsKebab, enumAsLower } from '../../src/tsconfig/compiler-options';

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
