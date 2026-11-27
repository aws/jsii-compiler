import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { makeProjectInfo } from './make-project-info';
import { Compiler } from '../../../src/compiler';
import { CompilerHost } from '../../../src/compiler-host';

/**
 * Which standard library files the TypeScript 7 program gets for the "lib" setting of a user-provided tsconfig.
 *
 * On main, the tests "respect "lib" setting from user-provided config" and "missing "lib" setting is based on
 * compilation target" in test/compiler.test.ts spy on `ts.createIncrementalProgram` (see
 * https://github.com/aws/jsii-compiler/issues/3042). The TypeScript 7 compiler has no in-process program to spy on, so
 * these tests read the files of the program the compiler opened instead.
 */

let sourceDir: string;

beforeEach(() => {
  sourceDir = mkdtempSync(join(tmpdir(), 'jsii-compiler-lib-'));
  writeFileSync(join(sourceDir, 'index.ts'), 'export class MarkerA {}');
  writeFileSync(join(sourceDir, 'README.md'), '# Test Package');
});

afterEach(() => {
  jest.restoreAllMocks();
  rmSync(sourceDir, { force: true, recursive: true });
});

/** Compiles with the given compiler options in a user-provided tsconfig; returns the base names of the program's files. */
function programFiles(compilerOptions: Record<string, unknown>): string[] {
  writeFileSync(
    join(sourceDir, 'tsconfig.dev.json'),
    JSON.stringify({ compilerOptions: { strict: true, declaration: true, ...compilerOptions }, include: ['**/*.ts'] }),
  );
  const files: string[] = [];
  const getProject = CompilerHost.prototype.getProject;
  jest.spyOn(CompilerHost.prototype, 'getProject').mockImplementation(function (this: CompilerHost) {
    const project = getProject.call(this);
    files.push(...project.program.getSourceFileNames().map((f: string) => basename(f)));
    return project;
  });

  new Compiler({ projectInfo: makeProjectInfo(sourceDir, 'index.d.ts'), typeScriptConfig: 'tsconfig.dev.json' }).emit();

  return files;
}

test('the program gets the "lib" of a user-provided tsconfig', () => {
  const files = programFiles({ target: 'es2022', module: 'commonjs', lib: ['Decorators.Legacy'] });

  expect(files).toContain('lib.decorators.legacy.d.ts');
  expect(files).not.toContain('lib.es2022.d.ts');
});

test('without "lib", the program gets the standard library of the compilation target', () => {
  const files = programFiles({ target: 'es6', module: 'commonjs' });

  expect(files).toContain('lib.es6.d.ts');
});
