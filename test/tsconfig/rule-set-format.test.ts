import chalk from 'chalk';
import { TypeScriptConfigValidationRuleSet } from '../../src/tsconfig';
import {
  formatConstraint,
  formatRuleSet,
  formatRuleValue,
  RULE_SET_DESCRIPTIONS,
} from '../../src/tsconfig/rule-set-format';
import { RuleDescription, RuleType } from '../../src/tsconfig/validator';

// Render deterministically (no ANSI escape codes) so assertions match plain text.
let previousChalkLevel: chalk.Level;
beforeAll(() => {
  previousChalkLevel = chalk.level;
  chalk.level = 0;
});
afterAll(() => {
  chalk.level = previousChalkLevel;
});

describe('formatRuleValue()', () => {
  test('renders strings verbatim', () => {
    expect(formatRuleValue('es2022')).toBe('es2022');
  });

  test('JSON-encodes non-string values', () => {
    expect(formatRuleValue(true)).toBe('true');
    expect(formatRuleValue(false)).toBe('false');
    expect(formatRuleValue(['es2022'])).toBe('["es2022"]');
  });
});

describe('formatConstraint()', () => {
  function rule(partial: Partial<RuleDescription>): RuleDescription {
    return { field: 'x', type: RuleType.PASS, required: false, ...partial };
  }

  test('PASS with a single value', () => {
    expect(formatConstraint(rule({ type: RuleType.PASS, values: [true] }))).toBe('must be true');
  });

  test('PASS with multiple values', () => {
    expect(formatConstraint(rule({ type: RuleType.PASS, values: ['es2022', 'es2023'] }))).toBe(
      'must be one of: es2022, es2023',
    );
  });

  test('FAIL with a single value', () => {
    expect(formatConstraint(rule({ type: RuleType.FAIL, values: [true] }))).toBe('must not be true');
  });

  test('FAIL with multiple values', () => {
    expect(formatConstraint(rule({ type: RuleType.FAIL, values: ['amd', 'umd'] }))).toBe(
      'must not be one of: amd, umd',
    );
  });

  test('PASS without hinted values allows anything', () => {
    expect(formatConstraint(rule({ type: RuleType.PASS, values: undefined }))).toBe('any value');
  });

  test('null/undefined hints mean the option is not allowed', () => {
    expect(formatConstraint(rule({ type: RuleType.PASS, values: [undefined, null] }))).toBe('not allowed');
  });
});

describe('formatRuleSet()', () => {
  test('includes the heading and description', () => {
    const out = formatRuleSet(TypeScriptConfigValidationRuleSet.STRICT);
    expect(out).toContain('Rule set: strict');
    expect(out).toContain(RULE_SET_DESCRIPTIONS.strict);
  });

  test('strict rejects unknown options and surfaces required + allowed values', () => {
    const out = formatRuleSet(TypeScriptConfigValidationRuleSet.STRICT);
    expect(out).toContain('other options: rejected');
    expect(out).toMatch(/target\s+required; must be one of: es2022, es2023, esnext; must not be es5/);
  });

  test('dedupes identical overlapping constraints', () => {
    const out = formatRuleSet(TypeScriptConfigValidationRuleSet.STRICT);
    // alwaysStrict is constrained by two rules that both resolve to "must be true"
    expect(out).not.toContain('must be true; must be true');
    expect(out).toMatch(/alwaysStrict\s+must be true$/m);
  });

  test('minimal allows unknown options', () => {
    const out = formatRuleSet(TypeScriptConfigValidationRuleSet.MINIMAL);
    expect(out).toContain('other options: allowed');
    expect(out).toMatch(/noEmit\s+must not be true/);
  });

  test('off reports that validation is disabled', () => {
    const out = formatRuleSet(TypeScriptConfigValidationRuleSet.NONE);
    expect(out).toContain('Rule set: off');
    expect(out).toContain('No rules.');
  });
});

describe('RULE_SET_DESCRIPTIONS', () => {
  test('has a description for every rule set', () => {
    for (const ruleSet of Object.values(TypeScriptConfigValidationRuleSet)) {
      expect(typeof RULE_SET_DESCRIPTIONS[ruleSet]).toBe('string');
      expect(RULE_SET_DESCRIPTIONS[ruleSet].length).toBeGreaterThan(0);
    }
  });
});
