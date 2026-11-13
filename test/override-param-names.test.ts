import { DiagnosticCategory } from 'typescript';

import { compileJsiiForTest } from '../src';
import { JsiiDiagnostic } from '../src/jsii-diagnostic';
import { isSilenced } from '../src/warnings';

describe('JSII_5022: overrides and implementations must keep parameter names', () => {
  test('warns when an implementation renames a parameter of the interface method', () => {
    expect(
      paramNameWarnings(`
        export interface IResource {
          myFunc(myParam: string): string;
        }

        export class Resource implements IResource {
          public myFunc(myParamWithDifferentName: string) {
            return myParamWithDifferentName;
          }
        }
      `),
    ).toEqual([
      '"testpkg.Resource#myFunc" renames parameter "myParam" to "myParamWithDifferentName" when implementing testpkg.IResource. Rename it to "myParam": parameter names are part of the API in languages with keyword arguments (e.g. Python)',
    ]);
  });

  test('warns when an override renames a parameter of the base class method', () => {
    expect(
      paramNameWarnings(`
        export class Base {
          public myFunc(myParam: string): string {
            return myParam;
          }
        }

        export class Derived extends Base {
          public myFunc(other: string): string {
            return other;
          }
        }
      `),
    ).toEqual([
      expect.stringMatching(
        /^"testpkg.Derived#myFunc" renames parameter "myParam" to "other" when overriding testpkg.Base\./,
      ),
    ]);
  });

  test('warns for underscore-prefixed parameters, because Python keeps the leading underscore', () => {
    expect(
      paramNameWarnings(`
        export interface IResource {
          myFunc(myParam: string): string;
        }

        export class Resource implements IResource {
          public myFunc(_myParam: string) {
            return 'ignored';
          }
        }
      `),
    ).toEqual([expect.stringMatching(/renames parameter "myParam" to "_myParam"/)]);
  });

  test('does not warn when parameter names match', () => {
    expect(
      paramNameWarnings(`
        export interface IResource {
          myFunc(myParam: string): string;
        }

        export class Resource implements IResource {
          public myFunc(myParam: string) {
            return myParam;
          }
        }
      `),
    ).toEqual([]);
  });

  test('does not warn when a variadic parameter is renamed', () => {
    expect(
      paramNameWarnings(`
        export interface IResource {
          myFunc(...values: string[]): string[];
        }

        export class Resource implements IResource {
          public myFunc(...others: string[]) {
            return others;
          }
        }
      `),
    ).toEqual([]);
  });

  test('can be suppressed on the declaration with @jsii suppress', () => {
    expect(
      paramNameWarnings(`
        export interface IResource {
          myFunc(myParam: string): string;
        }

        export class Resource implements IResource {
          /** @jsii suppress override-changes-param-name unused parameter */
          public myFunc(_myParam: string) {
            return 'ignored';
          }
        }
      `),
    ).toEqual([]);
  });
});

/** Returns the JSII5022 warnings that are not silenced */
function paramNameWarnings(source: string): string[] {
  const result = compileJsiiForTest(source, { captureDiagnostics: true });
  return result.diagnostics
    .filter(
      (diag) =>
        diag.category === DiagnosticCategory.Warning &&
        JsiiDiagnostic.isJsiiDiagnostic(diag) &&
        diag.jsiiCode === 5022 &&
        !isSilenced(diag),
    )
    .map((diag) => `${diag.messageText}`);
}
