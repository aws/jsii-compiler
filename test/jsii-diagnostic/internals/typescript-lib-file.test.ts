import * as fc from 'fast-check';
import { DiagnosticLocationFile, isTypeScriptLibFile, JsiiDiagnostic } from '../../../src/jsii-diagnostic';

// The check it replaces. It is polynomial on long names, so it only runs on short ones here.
const LIB_FILE_REGEX = /[\\/]typescript(-[^\\/]+)?[\\/]lib[\\/]lib\..+\.d\.ts$/;

describe(isTypeScriptLibFile, () => {
  test.each([
    // TypeScript 6
    ['/repo/node_modules/typescript/lib/lib.es2022.d.ts', true],
    ['C:\\repo\\node_modules\\typescript\\lib\\lib.dom.d.ts', true],
    ['/repo/node_modules/typescript\\lib/lib.es5.d.ts', true],
    ['/repo/node_modules/typescript/lib/lib.a/b.d.ts', true],
    // TypeScript 7
    ['/repo/node_modules/@typescript/typescript-linux-arm64/lib/lib.es2015.collection.d.ts', true],
    ['C:\\repo\\node_modules\\@typescript\\typescript-win32-x64\\lib\\lib.es5.d.ts', true],
    ['/repo/node_modules/@typescript/typescript-/lib/lib.es5.d.ts', false],
    ['/repo/node_modules/@typescript/native/lib/lib.es5.d.ts', false],
    // Neither
    ['/a/typescript/lib/lib.x.d.ts/typescript/lib/lib.y.d.ts', true],
    ['/a/typescript/lib/lib.x/other/lib/lib.y.d.ts', true],
    ['/repo/node_modules/typescript/lib/lib..d.ts', false],
    ['/repo/node_modules/typescript/lib/lib.d.ts', false],
    ['typescript/lib/lib.es5.d.ts', false],
    ['/lib/lib.es5.d.ts', false],
    ['/repo/node_modules/typescript/lib/lib.es5.ts', false],
    ['/repo/node_modules/typescript/lib/lib.es5.d.ts.map', false],
    ['/repo/node_modules/typescript/lib/other.d.ts', false],
    ['/repo/src/index.d.ts', false],
    ['/repo/node_modules/typescript/lib/lib.a\nb.d.ts', false],
    ['/x/typescript/lib/lib.a\n/typescript/lib/lib.b.d.ts', true],
    ['/x/typescript-a\nb/lib/lib.c.d.ts', true],
  ])('%j -> %s', (fileName, expected) => {
    expect(isTypeScriptLibFile(fileName)).toBe(expected);
    expect(LIB_FILE_REGEX.test(fileName)).toBe(expected);
  });

  test('accepts the same names as the regular expression', () => {
    const part = fc.constantFrom('/', '\\', 'typescript', '-', 'x', 'lib', 'lib.', '.d.ts', '.', 'd', '\n');
    fc.assert(
      fc.property(
        fc.array(part, { maxLength: 14 }).map((parts) => parts.join('')),
        (fileName) => {
          expect(isTypeScriptLibFile(fileName)).toBe(LIB_FILE_REGEX.test(fileName));
        },
      ),
      { numRuns: 10_000 },
    );
  });

  test('is fast on a long name', () => {
    const fileName = `/typescript/lib/lib.${'/typescript-x/lib/lib.'.repeat(50_000)}x`;
    const start = Date.now();
    expect(isTypeScriptLibFile(fileName)).toBe(false);
    expect(isTypeScriptLibFile(`${fileName}.d.ts`)).toBe(true);
    expect(isTypeScriptLibFile(`/${'lib/'.repeat(200_000)}lib.x.d.ts`)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  test('keeps related information out of the TypeScript lib files', () => {
    const at = (fileName: string) => ({
      file: new DiagnosticLocationFile(fileName, 'declare var Error: ErrorConstructor;'),
      start: 0,
      length: 5,
    });
    const diagnostic = JsiiDiagnostic.JSII_0001_PKG_MISSING_DESCRIPTION.createDetached()
      .addRelatedInformation(at('/repo/node_modules/@typescript/typescript-linux-x64/lib/lib.es5.d.ts'), 'skipped')
      .addRelatedInformation(at('/repo/node_modules/typescript/lib/lib.es5.d.ts'), 'skipped')
      .addRelatedInformation(at('/repo/lib/index.ts'), 'kept');
    expect(diagnostic.relatedInformation.map((info) => info.messageText)).toEqual(['kept']);
  });
});
