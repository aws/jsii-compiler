import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeProjectInfo } from './make-project-info';
import { Compiler } from '../../../src/compiler';
import { DiagnosticCategory } from '../../../src/diagnostic';

/**
 * Compiler options that TypeScript 7 rejects in a user-provided tsconfig are reported by TypeScript, as tsc reports
 * them. Main (TypeScript 6) drops them silently; see TYPESCRIPT-7.md.
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

test.each([
  ['an unknown option', { notAnOption: true }, 5023],
  ['a value of the wrong type', { declaration: 'yes' }, 5024],
  ['a value that is not allowed', { target: 'es1999' }, 6046],
])('%s fails the build with the TypeScript error', (_description, compilerOptions, code) => {
  writeFileSync(
    join(sourceDir, 'tsconfig.dev.json'),
    JSON.stringify({
      compilerOptions: { target: 'es2022', module: 'node16', lib: ['es2022'], strict: true, ...compilerOptions },
      include: ['**/*.ts'],
    }),
  );

  const result = new Compiler({
    projectInfo: makeProjectInfo(sourceDir, 'index.d.ts'),
    typeScriptConfig: 'tsconfig.dev.json',
  }).emit();

  expect(result.emitSkipped).toBe(true);
  expect(result.diagnostics.filter((d) => d.category === DiagnosticCategory.Error)).toEqual([
    expect.objectContaining({ code }),
  ]);
});
