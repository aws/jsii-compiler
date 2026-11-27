import * as spec from '@jsii/spec';
import { DiagnosticCategory } from 'typescript';

import { compileJsiiForTest } from '../../../lib';

// --strip-deprecated removes what the assembly lists as deprecated, after visiting it (as the classic compiler did).

test('a type without a stability tag inherits the stability of the package', () => {
  const result = compileJsiiForTest(
    `
      export class Inherited {}
      /** @stable */
      export class Stable {
        public method() {}
      }
      /** @stability deprecated */
      export class Tagged {}
    `,
    { packageJson: { stability: spec.Stability.Deprecated } },
    { stripDeprecated: true },
  );
  expect(Object.keys(result.assembly.types ?? {})).toEqual(['testpkg.Stable']);
  expect(result.assembly.types?.['testpkg.Stable']).toHaveProperty('methods', [
    expect.objectContaining({ name: 'method' }),
  ]);
});

test('the nested types of a stripped type stay', () => {
  const result = compileJsiiForTest(
    `
      /** @deprecated gone */
      export class Old {}
      export namespace Old {
        export interface Props { readonly x: string }
      }
    `,
    undefined,
    { stripDeprecated: true },
  );
  expect(Object.keys(result.assembly.types ?? {})).toEqual(['testpkg.Old.Props']);
});

test('a stripped struct is still checked as a keyword argument', () => {
  const result = compileJsiiForTest(
    `
      /** @deprecated gone */
      export interface Old { readonly x: string }
      export class Use {
        public method(x: string, old: Old) { void x; void old; }
      }
    `,
    { captureDiagnostics: true },
    { stripDeprecated: true },
  );
  expect(result.diagnostics.map((d) => (d as { jsiiCode?: number }).jsiiCode)).toContain(5017);
});

test('a use of a stripped type of a submodule names its fqn', () => {
  const result = compileJsiiForTest(
    {
      'index.ts': `
        export * as sub from './sub';
        import { Old } from './sub';
        export class Use {
          public method(old: Old): void { void old; }
        }
      `,
      'sub.ts': `
        /** @deprecated gone */
        export interface Old { readonly x: string }
      `,
    },
    { captureDiagnostics: true },
    { stripDeprecated: true },
  );
  const errors = result.diagnostics.filter((d) => d.category === DiagnosticCategory.Error);
  expect(errors.map((d) => d.messageText).sort()).toEqual([
    'Exported APIs cannot use un-exported type "testpkg.sub.Old"',
    'Parameter has @deprecated type testpkg.sub.Old, and it is erased by --strip-deprecated.',
  ]);
});
