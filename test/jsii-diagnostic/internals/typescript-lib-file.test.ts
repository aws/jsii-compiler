import * as fc from 'fast-check';
import { isTypeScriptLibFile } from '../../../src/jsii-diagnostic';

// The check it replaces. It is polynomial on long names, so it only runs on short ones here.
const LIB_FILE_REGEX = /[\\/]typescript[\\/]lib[\\/]lib\..+\.d\.ts$/;

describe(isTypeScriptLibFile, () => {
  test.each([
    ['/repo/node_modules/typescript/lib/lib.es2022.d.ts', true],
    ['C:\\repo\\node_modules\\typescript\\lib\\lib.dom.d.ts', true],
    ['/repo/node_modules/typescript\\lib/lib.es5.d.ts', true],
    ['/repo/node_modules/typescript/lib/lib.a/b.d.ts', true],
    ['/a/typescript/lib/lib.x.d.ts/typescript/lib/lib.y.d.ts', true],
    ['/repo/node_modules/typescript/lib/lib..d.ts', false],
    ['/repo/node_modules/typescript/lib/lib.x.d.ts', true],
    ['/repo/node_modules/typescript/lib/lib.d.ts', false],
    ['typescript/lib/lib.es5.d.ts', false],
    ['/repo/node_modules/typescript/lib/lib.es5.ts', false],
    ['/repo/node_modules/typescript/lib/lib.es5.d.ts.map', false],
    ['/repo/node_modules/typescript/lib/other.d.ts', false],
    ['/repo/src/index.d.ts', false],
    ['/repo/node_modules/typescript/lib/lib.a\nb.d.ts', false],
    ['/x/typescript/lib/lib.a\n/typescript/lib/lib.b.d.ts', true],
  ])('%j -> %s', (fileName, expected) => {
    expect(isTypeScriptLibFile(fileName)).toBe(expected);
    expect(LIB_FILE_REGEX.test(fileName)).toBe(expected);
  });

  test('accepts the same names as the regular expression', () => {
    const part = fc.constantFrom('/', '\\', 'typescript', 'lib', 'lib.', '.d.ts', '.', 'd', 'x', '\n');
    fc.assert(
      fc.property(
        fc.array(part, { maxLength: 12 }).map((parts) => parts.join('')),
        (fileName) => {
          expect(isTypeScriptLibFile(fileName)).toBe(LIB_FILE_REGEX.test(fileName));
        },
      ),
      { numRuns: 5_000 },
    );
  });

  test('is fast on a long name', () => {
    const fileName = `/typescript/lib/lib.${'/typescript/lib/lib.'.repeat(50_000)}x`;
    const start = Date.now();
    expect(isTypeScriptLibFile(fileName)).toBe(false);
    expect(isTypeScriptLibFile(`${fileName}.d.ts`)).toBe(true);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
