import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BackgroundCheck } from '../../../src/background-check';
import { resolveTypeScript7PackageDir } from '../../../src/compiler-host';
import { DiagnosticCategory } from '../../../src/diagnostic';

// Under jest the worker runs the compiled `lib/background-check.js`, not the source: fail here when it is missing
// (the worker is then skipped silently). Build first.
// shortcut: a stale build is not detected (the build only rewrites a file whose content changed, so its date says little).
test('the compiled worker is there', () => {
  expect(fs.existsSync(path.resolve(__dirname, '../../../lib/background-check.js'))).toBe(true);
});

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jsii-background-check-'));
  fs.writeFileSync(
    path.join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'es2022', module: 'node20', strict: true, outDir: 'out', rootDir: '.' },
    }),
  );
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function check(noEmitOnError: boolean) {
  return BackgroundCheck.start({
    packageDir: resolveTypeScript7PackageDir(),
    projectRoot,
    tsconfigPath: path.join(projectRoot, 'tsconfig.json'),
    errorCategory: DiagnosticCategory.Error,
    categories: [
      DiagnosticCategory.Warning,
      DiagnosticCategory.Error,
      DiagnosticCategory.Suggestion,
      DiagnosticCategory.Message,
    ],
    noEmitOnError,
  })!;
}

test('checks and emits the project', () => {
  fs.writeFileSync(path.join(projectRoot, 'a.ts'), 'export class A {}\n');

  const result = check(true).wait();

  expect(result?.diagnostics).toEqual([]);
  expect(result?.emit?.emittedFiles).toContainEqual(expect.stringMatching(/out[\\/]a\.js$/));
  expect(fs.existsSync(path.join(projectRoot, 'out', 'a.js'))).toBe(true);
});

test('reports errors, and does not emit when errors skip the emit', () => {
  fs.writeFileSync(path.join(projectRoot, 'a.ts'), 'export const x: number = "a";\n');

  const result = check(true).wait();

  expect(result?.diagnostics).toEqual([expect.objectContaining({ code: 2322, category: DiagnosticCategory.Error })]);
  expect(result?.emit).toBeUndefined();
  expect(fs.existsSync(path.join(projectRoot, 'out', 'a.js'))).toBe(false);
});

test('emits despite errors when they do not skip the emit', () => {
  fs.writeFileSync(path.join(projectRoot, 'a.ts'), 'export const x: number = "a";\n');

  const result = check(false).wait();

  expect(result?.diagnostics).toHaveLength(1);
  expect(fs.existsSync(path.join(projectRoot, 'out', 'a.js'))).toBe(true);
});

test('gives no result when the worker fails, so the build checks and emits in its own process', () => {
  fs.writeFileSync(path.join(projectRoot, 'a.ts'), 'export class A {}\n');

  const failing = BackgroundCheck.start({
    packageDir: path.join(projectRoot, 'no-typescript-here'),
    projectRoot,
    tsconfigPath: path.join(projectRoot, 'tsconfig.json'),
    errorCategory: DiagnosticCategory.Error,
    categories: [DiagnosticCategory.Error],
    noEmitOnError: true,
  });

  expect(failing?.wait()).toBeUndefined();
  expect(fs.existsSync(path.join(projectRoot, 'out', 'a.js'))).toBe(false);
});
