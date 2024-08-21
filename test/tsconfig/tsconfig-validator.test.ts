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

describe('ruleset: strict', () => {
  test('can set outDir', () => {
    const validator = new TypeScriptConfigValidator(TypeScriptConfigValidationRuleSet.STRICT);
    validator.validate({
      compilerOptions: {
        outDir: 'lib',

        // minimal stuff to pass test
        strict: true,
        target: 'es2022' as any,
        lib: ['es2022'],
        module: 'node16' as any,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmitOnError: true,
        declaration: true,
      },
    });
  });
});
