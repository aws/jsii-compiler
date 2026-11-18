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

  test('does not warn when only a leading underscore differs, because it is dropped from the API', () => {
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

        export class Base {
          public supports(_construct: string): boolean {
            return true;
          }
        }

        export class Derived extends Base {
          public supports(construct: string): boolean {
            return construct !== '';
          }
        }
      `),
    ).toEqual([]);
  });

  test('warns when the leading underscore is kept because dropping it would clash', () => {
    expect(
      paramNameWarnings(`
        export interface IResource {
          myFunc(_a: string, a: string): string;
        }

        export class Resource implements IResource {
          public myFunc(a: string, _a: string) {
            return a;
          }
        }
      `),
    ).toEqual([
      expect.stringMatching(/renames parameter "_a" to "a"/),
      expect.stringMatching(/renames parameter "a" to "_a"/),
    ]);
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

  test('does not warn when the trailing struct parameter is renamed, because its name is not part of the API', () => {
    expect(
      paramNameWarnings(`
        export interface FileAssetSource {
          readonly sourceHash: string;
          readonly fileName?: string;
        }

        export class DefaultSynthesizer {
          public addFileAsset(asset: FileAssetSource): string {
            return asset.sourceHash;
          }
        }

        export class BootstraplessSynthesizer extends DefaultSynthesizer {
          public addFileAsset(_asset: FileAssetSource): string {
            throw new Error('Cannot add assets');
          }
        }

        export interface IBucket {
          addRule(id: string, options?: FileAssetSource): void;
        }

        export class Bucket implements IBucket {
          public addRule(id: string, props?: FileAssetSource): void {
            Array.isArray([id, props]);
          }
        }
      `),
    ).toEqual([]);
  });

  test('warns when a struct parameter is renamed but is not the last parameter', () => {
    expect(
      paramNameWarnings(`
        export interface Props {
          readonly value: string;
        }

        export interface IResource {
          myFunc(props: Props, id: string): string;
        }

        export class Resource implements IResource {
          public myFunc(options: Props, id: string) {
            return options.value + id;
          }
        }
      `),
    ).toEqual([expect.stringMatching(/renames parameter "props" to "options"/)]);
  });

  test('warns when the trailing parameter is a union that includes a struct', () => {
    expect(
      paramNameWarnings(`
        export interface Props {
          readonly value: string;
        }

        export interface IResource {
          myFunc(props: Props | string): string;
        }

        export class Resource implements IResource {
          public myFunc(options: Props | string) {
            return typeof options === 'string' ? options : options.value;
          }
        }
      `),
    ).toEqual([expect.stringMatching(/renames parameter "props" to "options"/)]);
  });

  test('can be suppressed on the declaration with @jsii suppress', () => {
    expect(
      paramNameWarnings(`
        export interface IResource {
          myFunc(myParam: string): string;
        }

        export class Resource implements IResource {
          /** @jsii suppress override-changes-param-name renamed on purpose */
          public myFunc(other: string) {
            return other;
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
