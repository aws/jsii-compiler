import { TypeScriptConfig, TypeScriptConfigValidationRuleSet } from '.';
import generated from './rulesets/generated.public';
import minimal from './rulesets/minimal.public';
import strict from './rulesets/strict.public';
import { Match, ObjectValidator, RuleSet, RuleType } from './validator';

const RuleSets: {
  [name in TypeScriptConfigValidationRuleSet]: RuleSet;
} = {
  generated,
  strict,
  minimal,
  off: new RuleSet(),
};

export class TypeScriptConfigValidator {
  private readonly validator: ObjectValidator;
  private readonly compilerOptions: ObjectValidator;

  public constructor(public ruleSet: TypeScriptConfigValidationRuleSet) {
    const topLevelRules = new RuleSet({
      unexpectedFields: RuleType.PASS,
    });
    topLevelRules.shouldPass('files', Match.ANY);
    topLevelRules.shouldPass('extends', Match.ANY);
    topLevelRules.shouldPass('include', Match.ANY);
    topLevelRules.shouldPass('exclude', Match.ANY);
    topLevelRules.shouldPass('references', Match.ANY);
    topLevelRules.shouldPass('watchOptions', Match.ANY);
    topLevelRules.shouldPass('typeAcquisition', Match.MISSING);

    this.compilerOptions = new ObjectValidator(RuleSets[ruleSet], 'compilerOptions');
    topLevelRules.shouldPass('compilerOptions', (compilerOptions) => {
      this.compilerOptions.validate(compilerOptions);
      return true;
    });

    this.validator = new ObjectValidator(topLevelRules, 'tsconfig');
  }

  /**
   * Validated the provided config against the set of rules.
   *
   * @throws when the config is invalid
   *
   * @param tsconfig the tsconfig to be validated, this MUST be a tsconfig as a user would have written it in tsconfig.
   */
  public validate(tsconfig: TypeScriptConfig) {
    this.validator.validate(tsconfig);
  }
}
