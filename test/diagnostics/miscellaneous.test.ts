import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TestWorkspace, compileJsiiForTest } from '../../src/helpers';
import { compileJsiiForDiagnostics } from '../compiler-helpers';

describe('JSII9000 miscellaneous/unknown-module', () => {
  test('is reported when a type comes from a module that is not a declared dependency', () =>
    TestWorkspace.withWorkspace((ws) => {
      ws.addDependency(compileJsiiForTest('export class Foreign {}', { packageJson: { name: 'dependency' } }));

      const diagnostics = compileJsiiForDiagnostics(
        `
          import { Foreign } from 'dependency';
          export class Klass {
            public method(): Foreign {
              return new Foreign();
            }
          }
        `,
        { compilationDirectory: ws.rootDirectory },
      );

      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          jsiiCode: 9000,
          messageText:
            'Encountered use of module that is not declared in "dependencies" or "peerDependencies": "dependency"',
        }),
      );
    }));
});

describe('JSII9002 miscellaneous/unresolveable-type', () => {
  test('is reported when a built-in type that is not a jsii type is exposed', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export class Klass {
        public method(_arg: symbol) {}
      }
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 9002,
        messageText: expect.stringContaining('Type "Symbol" is part of the public API but not exported'),
      }),
    );
  });
});

describe('JSII9003 miscellaneous/unresolveable-module', () => {
  let externalDir: string;

  beforeEach(() => {
    // A directory that is not inside any package (no package.json in any parent).
    externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsii-external-'));
    fs.writeFileSync(path.join(externalDir, 'external.d.ts'), 'export declare class External {}');
  });

  afterEach(() => {
    fs.rmSync(externalDir, { recursive: true, force: true });
  });

  test('is reported when a type is declared in a location that is not part of any package', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      import { External } from '${externalDir}/external';
      export class Klass {
        public method(): External {
          return null as any;
        }
      }
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 9003,
        messageText: `Unable to resolve module location "${externalDir}/external"`,
      }),
    );
  });
});

describe('JSII9997 miscellaneous/unknown-error', () => {
  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2943
  // @TODO(ts7): expects a jsii validation diagnostic (JSII9000-JSII9003, JSII9997); re-enable with the port of the validator
  test.skip('is reported (with no source location) when a class extends a constructor-typed interface value', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export interface IFoo { readonly x: string }
      declare const Base: { new (): IFoo };
      export class Klass extends Base {}
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 9997,
        messageText: expect.stringContaining('Unknown error: Oh no'),
      }),
    );
  });

  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2943
  // @TODO(ts7): expects a jsii validation diagnostic (JSII9000-JSII9003, JSII9997); re-enable with the port of the validator
  test.skip('is reported (with no source location) when a class without a constructor extends a constructor-typed interface value, and other types come first', () => {
    // The unrelated interface changes the order in which the compiler checks the types.
    const diagnostics = compileJsiiForDiagnostics(`
      export interface I { readonly x: string }
      export interface IOther extends I { readonly y: string }
      declare const C: { new(): I };
      export class B extends C {}
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 9997,
        messageText: expect.stringContaining('Unknown error: Oh no'),
      }),
    );
  });
});

describe('JSII8006 code-style/underscored-members-must-be-internal', () => {
  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2971
  // TypeScript does not attach a comment to a declaration when the comment starts on a line with code before it.
  test('is reported for a member marked @internal by a comment that follows code on the same line', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export class X { /** @internal */ public _ok = 1; }

      export class Y {
        public a = 1; /** @internal */ public _b = 2;
      }

      export class Z {
        /** @internal */ public _c = 1;
      }
    `);

    expect(diagnostics.filter((d) => d.jsiiCode === 8006).map((d) => d.messageText)).toEqual([
      'Members with a name starting with "_" (e.g: "_ok") must be marked @internal',
      'Members with a name starting with "_" (e.g: "_b") must be marked @internal',
    ]);
  });
});
