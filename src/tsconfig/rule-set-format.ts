import chalk from 'chalk';
import { TypeScriptConfigValidationRuleSet } from '.';
import { describeRuleSet, getCompilerOptionsRuleSet } from './tsconfig-validator';
import { RuleDescription, RuleType } from './validator';

/**
 * Human-readable descriptions for each tsconfig validation rule set.
 *
 * These are surfaced both as CLI option help (e.g. for `--validate-tsconfig` and
 * `--rule-set`) and as the heading when printing a rule set via `formatRuleSet`.
 */
export const RULE_SET_DESCRIPTIONS: {
  [choice in TypeScriptConfigValidationRuleSet]: string;
} = {
  [TypeScriptConfigValidationRuleSet.STRICT]:
    'Validates the provided config against a strict rule set designed for maximum backwards-compatibility.',
  [TypeScriptConfigValidationRuleSet.GENERATED]:
    'Enforces a config as created by --generate-tsconfig. Use this to stay compatible with the generated config, but have full ownership over the file.',
  [TypeScriptConfigValidationRuleSet.MINIMAL]:
    'Only enforce options that are known to be incompatible with jsii. This rule set is likely to be incomplete and new rules will be added without notice as incompatibilities emerge.',
  [TypeScriptConfigValidationRuleSet.NONE]:
    'Disables all config validation, including options that are known to be incompatible with jsii. Intended for experimentation only. Use at your own risk.',
};

/**
 * Render a single rule set (its `compilerOptions` rules) as a human-readable block.
 *
 * @param ruleSet the rule set to render
 * @returns a multi-line string suitable for printing to the console
 */
export function formatRuleSet(ruleSet: TypeScriptConfigValidationRuleSet): string {
  const lines: string[] = [`${chalk.bold('Rule set:')} ${chalk.bold.cyan(ruleSet)}`];

  const description = RULE_SET_DESCRIPTIONS[ruleSet];
  if (description) {
    lines.push(chalk.dim(description));
  }

  const rules = describeRuleSet(ruleSet);
  if (rules.length === 0) {
    lines.push('');
    lines.push(chalk.dim('  No rules. Configuration validation is disabled for this rule set.'));
    return lines.join('\n');
  }

  const unknownRejected = getCompilerOptionsRuleSet(ruleSet).options.unexpectedFields === RuleType.FAIL;
  lines.push('');
  lines.push(chalk.dim(`Applies to: compilerOptions (other options: ${unknownRejected ? 'rejected' : 'allowed'})`));
  lines.push('');

  // Group rules by field, preserving the order in which each field first appears.
  const byField = new Map<string, RuleDescription[]>();
  for (const rule of rules) {
    const list = byField.get(rule.field) ?? [];
    list.push(rule);
    byField.set(rule.field, list);
  }

  const width = Math.max(...[...byField.keys()].map((field) => field.length));
  for (const [field, fieldRules] of byField) {
    const phrases = fieldRules.map(formatConstraint);
    // A required field is surfaced as an explicit "required" constraint at the front.
    if (fieldRules.some((rule) => rule.required)) {
      phrases.unshift(chalk.italic('required'));
    }
    // Dedupe identical phrases (some fields are constrained by several rules that overlap).
    const constraints = [...new Set(phrases)].join('; ');
    lines.push(`  ${chalk.bold(field.padEnd(width))}  ${constraints}`);
  }

  return lines.join('\n');
}

/**
 * Render a single rule's constraint as a human-readable phrase.
 *
 * @param rule the rule description to render
 * @returns a phrase such as `must be one of: es2022, es2023` or `not allowed`
 */
export function formatConstraint(rule: RuleDescription): string {
  const { type, values } = rule;

  // No hints means the matcher accepts anything (e.g. Match.ANY).
  if (values === undefined) {
    return type === RuleType.PASS ? chalk.italic('any value') : 'must not be set to the matched value';
  }

  // Only null/undefined hints means the option must be absent (e.g. Match.MISSING).
  if (values.length > 0 && values.every((value) => value == null)) {
    return chalk.italic('not allowed');
  }

  const formatted = values.map(formatRuleValue);
  if (type === RuleType.FAIL) {
    return formatted.length > 1 ? `must not be one of: ${formatted.join(', ')}` : `must not be ${formatted[0]}`;
  }
  return formatted.length > 1 ? `must be one of: ${formatted.join(', ')}` : `must be ${formatted[0]}`;
}

/**
 * Render a single hinted value as a highlighted code literal. Strings are shown
 * verbatim (as a user writes them in tsconfig.json), everything else is JSON-encoded.
 *
 * @param value the hinted value to render
 * @returns the value as a (possibly colorized) code literal
 */
export function formatRuleValue(value: any): string {
  const literal = typeof value === 'string' ? value : JSON.stringify(value);
  return chalk.cyan(literal);
}
