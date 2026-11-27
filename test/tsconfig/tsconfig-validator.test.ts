import fc from 'fast-check';
import { fcTsconfig } from './helpers';
import { TypeScriptConfigValidationRuleSet } from '../../src/tsconfig';
import rulesForGenerated from '../../src/tsconfig/rulesets/generated.public';
import rulesForMinimal from '../../src/tsconfig/rulesets/minimal.public';
import rulesForStrict from '../../src/tsconfig/rulesets/strict.public';
import { TypeScriptConfigValidator } from '../../src/tsconfig/tsconfig-validator';

describe('rule sets', () => {
  test('minimal', () => {
    fc.assert(
      fc.property(
        fcTsconfig({
          compilerRuleSet: rulesForMinimal,
        }),
        (config) => {
          const validator = new TypeScriptConfigValidator(TypeScriptConfigValidationRuleSet.MINIMAL);
          validator.validate(config);
        },
      ),
    );
  });

  test('generated', () => {
    fc.assert(
      fc.property(
        fcTsconfig({
          compilerRuleSet: rulesForGenerated,
        }),
        (config) => {
          const validator = new TypeScriptConfigValidator(TypeScriptConfigValidationRuleSet.GENERATED);
          validator.validate(config);
        },
      ),
    );
  });

  test('strict', () => {
    fc.assert(
      fc.property(
        fcTsconfig({
          compilerRuleSet: rulesForStrict,
        }),
        (config) => {
          const validator = new TypeScriptConfigValidator(TypeScriptConfigValidationRuleSet.STRICT);
          validator.validate(config);
        },
      ),
    );
  });
});

describe('ruleset: minimal', () => {
  test('rejects a config without declaration', () => {
    const validator = new TypeScriptConfigValidator(TypeScriptConfigValidationRuleSet.MINIMAL);
    expect(() => validator.validate({ compilerOptions: {} })).toThrow(
      'declaration: Expected value true, got: undefined',
    );
  });

  test('accepts declaration', () => {
    const validator = new TypeScriptConfigValidator(TypeScriptConfigValidationRuleSet.MINIMAL);
    validator.validate({ compilerOptions: { declaration: true } });
  });

  test('accepts composite without declaration', () => {
    const validator = new TypeScriptConfigValidator(TypeScriptConfigValidationRuleSet.MINIMAL);
    validator.validate({ compilerOptions: { composite: true } });
  });

  test('rejects composite: false without declaration', () => {
    const validator = new TypeScriptConfigValidator(TypeScriptConfigValidationRuleSet.MINIMAL);
    expect(() => validator.validate({ compilerOptions: { composite: false } })).toThrow(
      'declaration: Expected value true, got: undefined',
    );
  });

  test('rejects declaration: false even with composite', () => {
    const validator = new TypeScriptConfigValidator(TypeScriptConfigValidationRuleSet.MINIMAL);
    expect(() => validator.validate({ compilerOptions: { composite: true, declaration: false } })).toThrow(
      'declaration: Expected value not to be false, got: false',
    );
  });
});

describe('ruleset: strict', () => {
  test('can set outDir', () => {
    const validator = new TypeScriptConfigValidator(TypeScriptConfigValidationRuleSet.STRICT);
    validator.validate({
      compilerOptions: {
        outDir: 'lib',

        // minimal stuff to pass test
        strict: true,
        target: 'es2023' as any,
        lib: ['es2023'],
        module: 'node16' as any,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmitOnError: true,
        declaration: true,
      },
    });
  });

  test('accepts decorator metadata and type roots', () => {
    const validator = new TypeScriptConfigValidator(TypeScriptConfigValidationRuleSet.STRICT);
    validator.validate({
      compilerOptions: {
        strict: true,
        target: 'es2023' as any,
        lib: ['es2023'],
        module: 'node16' as any,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmitOnError: true,
        declaration: true,
        emitDecoratorMetadata: true,
        typeRoots: ['./node_modules/@types'],
      },
    });
  });

  test('rejects composite without declaration', () => {
    const validator = new TypeScriptConfigValidator(TypeScriptConfigValidationRuleSet.STRICT);
    expect(() =>
      validator.validate({
        compilerOptions: {
          composite: true,

          // minimal stuff to pass test, except declaration
          strict: true,
          target: 'es2023' as any,
          lib: ['es2023'],
          module: 'node16' as any,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmitOnError: true,
        },
      }),
    ).toThrow(/^Data is invalid:\ndeclaration: Expected value true, got: undefined$/);
  });
});
