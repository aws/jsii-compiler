import { TypeScriptConfig, TypeScriptConfigValidationRuleSet } from '.';
import generated from './rulesets/generated';
import minimal from './rulesets/minimal';
import strict from './rulesets/strict';
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
    topLevelRules.pass('files', Match.ANY);
    topLevelRules.pass('extends', Match.ANY);
    topLevelRules.pass('include', Match.ANY);
    topLevelRules.pass('exclude', Match.ANY);
    topLevelRules.pass('references', Match.ANY);
    topLevelRules.pass('watchOptions', Match.ANY);
    topLevelRules.pass('typeAcquisition', Match.MISSING);

    this.compilerOptions = new ObjectValidator(RuleSets[ruleSet], 'compilerOptions');
    topLevelRules.pass('compilerOptions', (actual) => {
      this.compilerOptions.validate(actual);
      return true;
    });

    this.validator = new ObjectValidator(topLevelRules, 'tsconfig');
  }

  /**
   * Validated the provided config against the set of rules.
   *
   * @throws when the config is invalid
   *
   * @param tsconfig the tsconfig to be validated
   */
  public validate(tsconfig: TypeScriptConfig) {
    this.validator.validate(tsconfig);
  }
}
