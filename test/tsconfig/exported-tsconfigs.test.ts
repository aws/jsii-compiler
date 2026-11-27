import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeScriptConfigValidationRuleSet } from '../../src/tsconfig';
import { BASE_COMPILER_OPTIONS, convertForJson } from '../../src/tsconfig/compiler-options';
import { readTypeScriptConfig, validateTypeScriptConfigFile } from '../../src/tsconfig/tsconfig-validator';

const packageRoot = join(__dirname, '..', '..');

describe('exported tsconfigs', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'jsii-exported-tsconfigs-'));
    mkdirSync(join(workdir, 'node_modules'));
    symlinkSync(packageRoot, join(workdir, 'node_modules', 'jsii'), 'junction');
  });

  afterEach(() => {
    // remove the link first, so the recursive removal can never reach the package root
    unlinkSync(join(workdir, 'node_modules', 'jsii'));
    rmSync(workdir, { force: true, recursive: true });
  });

  test.each([
    TypeScriptConfigValidationRuleSet.STRICT,
    TypeScriptConfigValidationRuleSet.GENERATED,
    TypeScriptConfigValidationRuleSet.MINIMAL,
  ])('extending jsii/tsconfig.%s.json passes the matching rule set', (ruleSet) => {
    const preset = `jsii/tsconfig.${ruleSet}.json`;
    expect(() => require.resolve(preset, { paths: [workdir] })).not.toThrow();

    const tsconfig = join(workdir, 'tsconfig.json');
    writeFileSync(tsconfig, JSON.stringify({ extends: preset }));

    expect(readTypeScriptConfig(tsconfig).compilerOptions.declaration).toBe(true);
    expect(validateTypeScriptConfigFile(tsconfig, ruleSet)).toEqual([]);
  });

  test('tsconfig.generated.json matches the generated compiler options', () => {
    const generated = JSON.parse(readFileSync(join(packageRoot, 'tsconfig-bases', 'tsconfig.generated.json'), 'utf-8'));

    expect(generated).toEqual({ compilerOptions: convertForJson(BASE_COMPILER_OPTIONS) });
  });
});
