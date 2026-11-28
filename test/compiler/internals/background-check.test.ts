import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BackgroundCheck } from '../../../src/background-check';
import { resolveTypeScript7PackageDir } from '../../../src/compiler-host';
import { DiagnosticCategory } from '../../../src/diagnostic';
import { compileJsiiForTest } from '../../../src/helpers';

// The background check only runs for big projects: run it for every project here.
let mockMinFiles = Infinity;
jest.mock('../../../src/background-check', () => ({
  ...jest.requireActual('../../../src/background-check'),
  get MIN_FILES_FOR_BACKGROUND_CHECK() {
    return mockMinFiles;
  },
}));

// The class indices the worker sends, and the classes of the decoded file (`jsClassIndices` in this process).
const mockPaired: Array<[readonly number[] | undefined, number[]]> = [];
jest.mock('../../../src/transforms/emitted-js', () => {
  const actual = jest.requireActual('../../../src/transforms/emitted-js');
  return {
    ...actual,
    pairClasses: (tsSource: any, jsSource: any, k: any, jsClassesAt?: readonly number[]) => {
      mockPaired.push([jsClassesAt, actual.jsClassIndices(jsSource, k)]);
      return actual.pairClasses(tsSource, jsSource, k, jsClassesAt);
    },
  };
});

const SOURCE = {
  'index.ts': `
    export * from './other';
    /** @deprecated use B */
    export class A {
      /** @deprecated use B */
      public constructor(public readonly x: number) {}
    }
    export abstract class B {
      public method(a: A): string { return \`\${a.x}\`; }
    }
  `,
  'other.ts': `
    export class C { public static readonly y = 1; }
    export function f() { return class Anonymous {}; }
  `,
};

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
  mockMinFiles = Infinity;
  jest.restoreAllMocks();
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

test('the emitted files are the same when the background check parses the emitted JavaScript', () => {
  const inProcess = compileJsiiForTest(SOURCE, undefined, { addDeprecationWarnings: true });
  mockPaired.length = 0;

  // The worker parses the emitted `.js` files after it posts its result: wait for each one, so this test does not
  // depend on how far ahead of the emit the worker is.
  const parsedJs = (BackgroundCheck.prototype as any).parsedJs;
  const decoded: string[] = [];
  jest.spyOn(BackgroundCheck.prototype as any, 'parsedJs').mockImplementation(function (this: any, ...args: any[]) {
    const sleep = new Int32Array(new SharedArrayBuffer(4));
    for (let tries = 0; tries < 1_000; tries++) {
      const parsed = parsedJs.apply(this, args);
      if (parsed != null) {
        decoded.push(args[0]);
        return parsed;
      }
      Atomics.wait(sleep, 0, 0, 10);
    }
    return undefined;
  });
  mockMinFiles = 0;
  const inBackground = compileJsiiForTest(SOURCE, undefined, { addDeprecationWarnings: true });

  expect(decoded.sort()).toEqual([expect.stringMatching(/index\.js$/), expect.stringMatching(/other\.js$/)]);
  expect(mockPaired).toHaveLength(2);
  for (const [fromWorker, inDecodedFile] of mockPaired) {
    expect(fromWorker).toEqual(inDecodedFile);
    expect(fromWorker?.length).toBeGreaterThan(0);
  }
  expect(inBackground.files).toEqual(inProcess.files);
  expect(inBackground.assembly).toEqual(inProcess.assembly);
});
