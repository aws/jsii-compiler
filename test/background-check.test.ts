import { BackgroundCheck } from '../src/background-check';
import { compileJsiiForTest } from '../src/helpers';

// The background check only runs for big projects: run it for every project here.
let mockMinFiles = Infinity;
jest.mock('../src/background-check', () => ({
  ...jest.requireActual('../src/background-check'),
  get MIN_FILES_FOR_BACKGROUND_CHECK() {
    return mockMinFiles;
  },
}));

// The class indices the worker sends, and the classes of the decoded file (`jsClassIndices` in this process).
const mockPaired: Array<[readonly number[] | undefined, number[]]> = [];
jest.mock('../src/transforms/emitted-js', () => {
  const actual = jest.requireActual('../src/transforms/emitted-js');
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

afterEach(() => {
  mockMinFiles = Infinity;
  jest.restoreAllMocks();
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
