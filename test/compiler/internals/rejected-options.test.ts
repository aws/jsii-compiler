import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeProjectInfo } from './make-project-info';
import { Compiler } from '../../../src/compiler';
import { DiagnosticCategory } from '../../../src/diagnostic';
import { TypeScriptConfigValidationRuleSet } from '../../../src/tsconfig';
import { TsconfigErrors } from '../../../src/tsconfig/read';
import { readTypeScriptConfig } from '../../../src/tsconfig/tsconfig-validator';

/**
 * TypeScript's errors for a user-provided tsconfig are reported, as tsc reports them. Main (TypeScript 6) drops them
 * silently; see TYPESCRIPT-7.md.
 */

let sourceDir: string;

beforeEach(() => {
  sourceDir = mkdtempSync(join(tmpdir(), 'jsii-compiler-rejected-options-'));
  writeFileSync(join(sourceDir, 'index.ts'), 'export class MarkerA {}');
  writeFileSync(join(sourceDir, 'README.md'), '# Test Package');
});

afterEach(() => {
  rmSync(sourceDir, { force: true, recursive: true });
});

const STRICT_OPTIONS = {
  target: 'es2022',
  module: 'node16',
  lib: ['es2022'],
  strict: true,
  declaration: true,
  noEmitOnError: true,
  esModuleInterop: true,
  skipLibCheck: true,
};

const CASES: Array<[string, Record<string, unknown>, Record<string, string>, number[]]> = [
  ['an unknown option', { compilerOptions: { notAnOption: true } }, {}, [5023]],
  ['a value of the wrong type', { compilerOptions: { declaration: 'yes' } }, {}, [5024]],
  ['a value that is not allowed', { compilerOptions: { target: 'es1999' } }, {}, [6046]],
  ['a missing base', { extends: './missing.json' }, {}, [5083]],
  [
    'a base that cannot be parsed',
    { extends: './base.json' },
    { 'base.json': '{ "compilerOptions": { "x": }' },
    [1005, 1109, 1328],
  ],
  [
    'a circular "extends"',
    { extends: './base.json' },
    { 'base.json': '{ "extends": "./tsconfig.dev.json" }' },
    [18000],
  ],
  [
    'an unknown option in a base',
    { extends: './base.json' },
    { 'base.json': '{ "compilerOptions": { "x": 1 } }' },
    [5023],
  ],
];

function writeTsconfig(tsconfig: Record<string, unknown>, files: Record<string, string>) {
  const { compilerOptions, ...rest } = tsconfig as { compilerOptions?: object };
  writeFileSync(
    join(sourceDir, 'tsconfig.dev.json'),
    JSON.stringify({ compilerOptions: { ...STRICT_OPTIONS, ...compilerOptions }, include: ['**/*.ts'], ...rest }),
  );
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(sourceDir, name), text);
  }
}

test.each(CASES)('%s fails the build with the TypeScript error', (_description, tsconfig, files, codes) => {
  writeTsconfig(tsconfig, files);

  const result = new Compiler({
    projectInfo: makeProjectInfo(sourceDir, 'index.d.ts'),
    typeScriptConfig: 'tsconfig.dev.json',
    validateTypeScriptConfig: TypeScriptConfigValidationRuleSet.STRICT,
  }).emit();

  expect(result.emitSkipped).toBe(true);
  expect(
    result.diagnostics
      .filter((d) => d.category === DiagnosticCategory.Error)
      .map((d) => d.code)
      .sort(),
  ).toEqual(codes);
});

test.each(CASES)('%s is reported when the tsconfig is read for validation', (_description, tsconfig, files, codes) => {
  writeTsconfig(tsconfig, files);

  let error: unknown;
  try {
    readTypeScriptConfig(join(sourceDir, 'tsconfig.dev.json'));
  } catch (e) {
    error = e;
  }

  expect(error).toBeInstanceOf(TsconfigErrors);
  expect((error as TsconfigErrors).diagnostics.map((d) => d.code).sort()).toEqual(codes);
});
