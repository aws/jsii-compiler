import * as path from 'node:path';
import * as ts from 'typescript';
import { TypeScriptConfig, TypeScriptConfigValidationRuleSet } from '.';
import { convertForJson } from './compiler-options';
import { JsiiError } from '../utils';
import generated from './rulesets/generated.public';
import minimal from './rulesets/minimal.public';
import strict from './rulesets/strict.public';
import { Match, ObjectValidator, RuleDescription, RuleSet, RuleType, ValidationError, Violation } from './validator';

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

/**
 * Returns the `compilerOptions` rule set that backs the given validation setting.
 *
 * These are the substantive, set-specific rules (the top-level rules such as
 * `files`/`include`/`exclude` are identical across all sets). The `off` rule set
 * is empty, as it disables validation.
 *
 * @param ruleSet the validation setting to look up
 * @returns the `RuleSet` applied to `compilerOptions`
 */
export function getCompilerOptionsRuleSet(ruleSet: TypeScriptConfigValidationRuleSet): RuleSet {
  return RuleSets[ruleSet];
}

/**
 * Produces a human-readable description of every `compilerOptions` rule in a rule set.
 *
 * @param ruleSet the validation setting to describe
 * @returns a description for every rule in the set
 */
export function describeRuleSet(ruleSet: TypeScriptConfigValidationRuleSet): RuleDescription[] {
  return getCompilerOptionsRuleSet(ruleSet).describe();
}

/**
 * Reads and parses a `tsconfig.json` file from disk into the format expected by
 * the validator. This resolves `extends` and normalizes the options the same way
 * the compiler does, so validation behaves identically to a real compilation.
 *
 * @param configPath the path to the tsconfig file to read
 * @throws {@link JsiiError} if the file cannot be read or parsed
 * @returns the parsed TypeScript configuration
 */
export function readTypeScriptConfig(configPath: string): TypeScriptConfig {
  const absolutePath = path.resolve(configPath);
  const { config, error } = ts.readConfigFile(absolutePath, ts.sys.readFile);
  if (error) {
    throw new JsiiError(
      `Failed to read tsconfig at "${configPath}": ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`,
    );
  }

  const basePath = path.dirname(absolutePath);
  const extended = ts.parseJsonConfigFileContent(config, ts.sys, basePath);
  // the tsconfig parser adds this in, but it is not an expected compilerOption
  delete extended.options.configFilePath;

  return {
    compilerOptions: extended.options,
    watchOptions: extended.watchOptions,
    include: extended.fileNames,
  };
}

/**
 * Reads a `tsconfig.json` file from disk and validates its `compilerOptions`
 * against the given rule set, without running a compilation.
 *
 * @param configPath the path to the tsconfig file to validate
 * @param ruleSet the rule set to validate against
 * @throws {@link JsiiError} if the file cannot be read or parsed
 * @returns the list of rule violations (empty if the config is valid)
 */
export function validateTypeScriptConfigFile(
  configPath: string,
  ruleSet: TypeScriptConfigValidationRuleSet,
): Violation[] {
  const config = readTypeScriptConfig(configPath);
  const validator = new TypeScriptConfigValidator(ruleSet);
  try {
    validator.validate({
      ...config,
      // convert the internal format to the user format which is what the validator operates on
      compilerOptions: convertForJson(config.compilerOptions),
    });
    return [];
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      return error.violations;
    }
    throw error;
  }
}
