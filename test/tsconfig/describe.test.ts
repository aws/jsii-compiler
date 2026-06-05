import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeScriptConfigValidationRuleSet } from '../../src/tsconfig';
import {
  describeRuleSet,
  getCompilerOptionsRuleSet,
  readTypeScriptConfig,
  validateTypeScriptConfigFile,
} from '../../src/tsconfig/tsconfig-validator';
import { Match, RuleSet, RuleType } from '../../src/tsconfig/validator';
import { JsiiError } from '../../src/utils';

describe('RuleSet.describe()', () => {
  test('describes a required "must be one of" PASS rule with hinted values', () => {
    const ruleSet = new RuleSet();
    ruleSet.shouldPass('target', Match.oneOf('es2022', 'es2023', 'esnext'));

    const [rule] = ruleSet.describe();
    expect(rule).toEqual({
      field: 'target',
      type: RuleType.PASS,
      required: true,
      values: ['es2022', 'es2023', 'esnext'],
    });
  });

  test('describes an optional PASS rule as not required', () => {
    const ruleSet = new RuleSet();
    ruleSet.shouldPass('stripInternal', Match.optional(Match.FALSE));

    const [rule] = ruleSet.describe();
    expect(rule.required).toBe(false);
    expect(rule.type).toBe(RuleType.PASS);
    expect(rule.values).toEqual([false]);
  });

  test('describes a FAIL rule with its disallowed values', () => {
    const ruleSet = new RuleSet();
    ruleSet.shouldFail('noEmit', Match.TRUE);

    const [rule] = ruleSet.describe();
    expect(rule.type).toBe(RuleType.FAIL);
    expect(rule.required).toBe(false);
    expect(rule.values).toEqual([true]);
  });

  test('describes a MISSING rule (values are null/undefined)', () => {
    const ruleSet = new RuleSet();
    ruleSet.shouldPass('prepend', Match.MISSING);

    const [rule] = ruleSet.describe();
    expect(rule.required).toBe(false);
    expect(rule.values).toEqual([undefined, null]);
  });

  test('describes a Match.ANY rule as having no hinted values', () => {
    const ruleSet = new RuleSet();
    ruleSet.shouldPass('incremental', Match.ANY);

    const [rule] = ruleSet.describe();
    expect(rule.values).toBeUndefined();
  });

  test('preserves rule order', () => {
    const ruleSet = new RuleSet();
    ruleSet.shouldPass('a', Match.ANY);
    ruleSet.shouldFail('b', Match.TRUE);

    expect(ruleSet.describe().map((r) => r.field)).toEqual(['a', 'b']);
  });
});

describe('describeRuleSet()', () => {
  test('strict requires a valid "target"', () => {
    const target = describeRuleSet(TypeScriptConfigValidationRuleSet.STRICT).find(
      (rule) => rule.field === 'target' && rule.type === RuleType.PASS,
    );

    expect(target).toBeDefined();
    expect(target?.required).toBe(true);
    expect(target?.values).toEqual(expect.arrayContaining(['es2022', 'es2023', 'esnext']));
  });

  test('"off" rule set has no compilerOptions rules', () => {
    expect(describeRuleSet(TypeScriptConfigValidationRuleSet.NONE)).toEqual([]);
  });

  test('strict rejects unknown options, minimal does not', () => {
    expect(getCompilerOptionsRuleSet(TypeScriptConfigValidationRuleSet.STRICT).options.unexpectedFields).toBe(
      RuleType.FAIL,
    );
    expect(getCompilerOptionsRuleSet(TypeScriptConfigValidationRuleSet.MINIMAL).options.unexpectedFields).toBe(
      RuleType.PASS,
    );
  });
});

describe('validateTypeScriptConfigFile()', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'jsii-validate-tsconfig-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  function writeConfig(contents: object): string {
    const configPath = join(workdir, 'tsconfig.json');
    writeFileSync(configPath, JSON.stringify(contents), 'utf-8');
    return configPath;
  }

  test('returns no violations for a config that satisfies the strict rule set', () => {
    const configPath = writeConfig({
      compilerOptions: {
        strict: true,
        target: 'es2023',
        lib: ['es2023'],
        module: 'node16',
        esModuleInterop: true,
        skipLibCheck: true,
        noEmitOnError: true,
        declaration: true,
      },
    });

    expect(validateTypeScriptConfigFile(configPath, TypeScriptConfigValidationRuleSet.STRICT)).toEqual([]);
  });

  test('returns violations for a config that breaks the strict rule set', () => {
    const configPath = writeConfig({
      compilerOptions: {
        strict: false,
        target: 'es2023',
        lib: ['es2023'],
        module: 'node16',
        esModuleInterop: true,
        skipLibCheck: true,
        noEmitOnError: true,
        declaration: true,
      },
    });

    const violations = validateTypeScriptConfigFile(configPath, TypeScriptConfigValidationRuleSet.STRICT);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.field === 'strict')).toBe(true);
  });

  test('flags a recognized option that is not on the strict allowlist', () => {
    const configPath = writeConfig({
      compilerOptions: {
        strict: true,
        target: 'es2023',
        lib: ['es2023'],
        module: 'node16',
        esModuleInterop: true,
        skipLibCheck: true,
        noEmitOnError: true,
        declaration: true,
        // a valid TypeScript option, but not part of the jsii strict allowlist
        removeComments: true,
      },
    });

    const violations = validateTypeScriptConfigFile(configPath, TypeScriptConfigValidationRuleSet.STRICT);
    expect(violations.some((v) => v.field === 'removeComments')).toBe(true);
  });

  test('throws a JsiiError when the file does not exist', () => {
    expect(() => readTypeScriptConfig(join(workdir, 'does-not-exist.json'))).toThrow(JsiiError);
  });
});
