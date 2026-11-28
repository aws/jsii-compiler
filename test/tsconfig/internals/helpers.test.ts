import fc from 'fast-check';
import { Match, RuleSet, RuleType } from '../../../src/tsconfig/validator';
import { fcTsconfig, fcTsconfigRealistic } from '../helpers';

// These tests cover the arbitraries that the property based tests in this directory are built on.

describe('fcTsconfig', () => {
  test('always generates compilerOptions', () => {
    fc.assert(fc.property(fcTsconfig(), (config) => config.compilerOptions !== undefined));
  });

  test('includes project references by default', () => {
    const configs = fc.sample(fcTsconfig(), { numRuns: 200, seed: 1 });

    expect(configs.some((config) => config.references !== undefined)).toBe(true);
  });

  test('can leave out project references', () => {
    fc.assert(fc.property(fcTsconfig({ references: false }), (config) => config.references === undefined));
  });

  test('can include typeAcquisition', () => {
    const configs = fc.sample(fcTsconfig({ typeAcquisition: true }), { numRuns: 200, seed: 1 });

    expect(configs.some((config) => config.typeAcquisition !== undefined)).toBe(true);
  });

  test('does not include typeAcquisition by default', () => {
    fc.assert(fc.property(fcTsconfig(), (config) => config.typeAcquisition === undefined));
  });

  test('generates the values a rule set requires or allows', () => {
    const rules = new RuleSet({ unexpectedFields: RuleType.FAIL });
    rules.shouldPass('target', Match.oneOf('es2022', 'es2023'));
    rules.shouldPass('strict', Match.TRUE);
    rules.shouldFail('declaration', Match.TRUE);
    rules.shouldPass('lib', Match.optional(Match.ANY));

    fc.assert(
      fc.property(fcTsconfig({ compilerRuleSet: rules }), ({ compilerOptions }) => {
        expect(['es2022', 'es2023']).toContain(compilerOptions.target);
        expect(compilerOptions.strict).toBe(true);
        expect(compilerOptions.declaration).not.toBe(true);
        expect(Object.keys(compilerOptions).every((key) => rules.fields.includes(key))).toBe(true);
      }),
    );
  });

  test('lets explicit arbitraries override the generated ones', () => {
    fc.assert(
      fc.property(
        fcTsconfig({ compilerArbs: { outDir: fc.constant('dist') }, watchArbs: { excludeFiles: fc.constant([]) } }),
        (config) =>
          config.watchOptions?.excludeFiles == null || (config.watchOptions.excludeFiles as unknown[]).length === 0,
      ),
    );
  });
});

describe('fcTsconfigRealistic', () => {
  test('does not generate options that depend on the file system', () => {
    fc.assert(
      fc.property(fcTsconfigRealistic(), ({ compilerOptions, references, typeAcquisition }) => {
        expect(compilerOptions.rootDir).toBeUndefined();
        expect(compilerOptions.paths).toBeUndefined();
        expect(compilerOptions.incremental).not.toBe(true);
        expect(compilerOptions.composite).not.toBe(true);
        expect(references).toBeUndefined();
        expect(typeAcquisition).toBeUndefined();
      }),
    );
  });
});
