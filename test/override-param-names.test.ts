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

  // Each case is an interface method, an implementation, and the renames (as Python callers see the names)
  // that must be reported. The expected names follow jsii-pacmak's Python output.
  test.each([
    ['all leading underscores are dropped', 'f(scope: string)', 'f(__scope: string)', []],
    ['a name that is only underscores is kept', 'f(_: string)', 'f(__: string)', [['_', '__']]],
    ['a name that would start with a digit is kept', 'f(_1: string)', 'f(__1: string)', [['_1', '__1']]],
    [
      'the underscore is kept when dropping it would clash, ignoring case',
      'f(_myURL: string, myUrl: string)',
      'f(myURL: string, _myUrl: string)',
      [
        ['_myURL', 'myURL'],
        ['myUrl', '_myUrl'],
      ],
    ],
    [
      'the underscore is kept when dropping it would clash, ignoring underscores',
      'f(_class: string, class_: string)',
      'f(__class: string, class_: string)',
      [['_class', '__class']],
    ],
    [
      'the underscore is kept on one side only',
      'f(_a: string, a: string)',
      'f(_a: string, b: string)',
      [
        ['_a', 'a'],
        ['a', 'b'],
      ],
    ],
    [
      'the underscore is kept when dropping it would clash with an inherited lifted property',
      'f(_inherited: string, props: ChildProps)',
      'f(__inherited: string, props: ChildProps)',
      [['_inherited', '__inherited']],
    ],
    [
      'the underscore is dropped when nothing clashes with the lifted properties',
      'f(other: string, props: ChildProps)',
      'f(_other: string, props: ChildProps)',
      [],
    ],
    [
      'the underscore is kept on a name the method body uses',
      'f(_jsii: string)',
      'f(__jsii: string)',
      [['_jsii', '__jsii']],
    ],
    [
      'the underscore is kept on the implicit parameter',
      'f(_self: string)',
      'f(__self: string)',
      [['_self', '__self']],
    ],
    [
      'the underscore is kept when dropping it would clash with a variadic parameter',
      'f(_a: string, ...a: string[])',
      'f(__a: string, ...a: string[])',
      [['_a', '__a']],
    ],
    [
      'the underscore is kept when dropping it would clash with the lifted parameter itself',
      'f(_props: string, props: ChildProps)',
      'f(__props: string, props: ChildProps)',
      [['_props', '__props']],
    ],
    [
      'the underscore is kept when dropping it would clash with a property of the lifted struct',
      'f(_own: string, props: ChildProps)',
      'f(__own: string, props: ChildProps)',
      [['_own', '__own']],
    ],
    [
      'the underscore is kept on a non-ASCII name',
      'f(_gr\u00f6\u00dfe: string)',
      'f(__gr\u00f6\u00dfe: string)',
      [['_gr\u00f6\u00dfe', '__gr\u00f6\u00dfe']],
    ],
    [
      'the underscore is kept when dropping it would clash after NFKC normalization',
      'f(_afi: string, a\ufb01: string)',
      'f(__afi: string, a\ufb01: string)',
      [['_afi', '__afi']],
    ],
    // Every name a generated Python method body uses
    ...[
      'self',
      'cls',
      'abc',
      'builtins',
      'datetime',
      'enum',
      'typing',
      'jsii',
      'publication',
      'typingExtensions',
      'cachedTypeHints',
      'checkType',
    ].map((name) => [
      `the underscore is kept on "${name}"`,
      `f(_${name}: string)`,
      `f(__${name}: string)`,
      [[`_${name}`, `__${name}`]],
    ]),
  ])('%s', (_title, declared, implemented, renames) => {
    const warnings = paramNameWarnings(`
      export interface BaseProps {
        readonly inherited: string;
      }

      export interface ChildProps extends BaseProps {
        readonly own?: string;
      }

      export interface IResource {
        ${declared}: void;
      }

      export abstract class Resource implements IResource {
        public abstract ${implemented}: void;
      }
    `);
    expect(warnings.map((warning) => /renames parameter "([^"]*)" to "([^"]*)"/.exec(warning)?.slice(1))).toEqual(
      renames,
    );
  });

  test('explains a difference that comes from an underscore kept on one side only', () => {
    expect(
      paramNameWarnings(`
        export interface IResource {
          f(_a: string, a: string): void;
        }

        export abstract class Resource implements IResource {
          public abstract f(_a: string, b: string): void;
        }
      `),
    ).toEqual([
      '"testpkg.Resource#f" renames parameter "_a" to "a" when implementing testpkg.IResource. Both declare it as "_a", but its leading underscore is only kept where dropping it would clash with another name, so give the other parameters the same names too: parameter names are part of the API in languages with keyword arguments (e.g. Python)',
      expect.stringMatching(/renames parameter "a" to "b" .* Rename it to "a":/),
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
