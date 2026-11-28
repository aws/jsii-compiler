import * as Case from '../case';
import type { CompilerOptionsJson } from './index';
import { loadTypeScriptApi } from '../compiler-host';

/**
 * The compiler options jsii always applies, in the JSON form they are written
 * to the generated `tsconfig.json`.
 */
export const BASE_COMPILER_OPTIONS: CompilerOptionsJson = {
  alwaysStrict: true,
  declaration: true,
  esModuleInterop: true,
  incremental: true,
  lib: ['es2023'],
  module: 'node20',
  noEmitOnError: true,
  noFallthroughCasesInSwitch: true,
  noImplicitAny: true,
  noImplicitReturns: true,
  noImplicitThis: true,
  noUncheckedSideEffectImports: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  strict: true,
  strictNullChecks: true,
  strictPropertyInitialization: true,
  stripInternal: false,
  target: 'es2023',
};

export function enumAsCamel(enumData: Record<string, string | number>): string[] {
  return Object.keys(enumData)
    .filter((v) => isNaN(Number(v)))
    .map(Case.camel);
}

export function enumAsLower(enumData: Record<string, string | number>): string[] {
  return Object.keys(enumData)
    .filter((v) => isNaN(Number(v)) && v !== 'None')
    .map((v) => v.toLowerCase());
}

export function enumAsKebab(enumData: Record<string, string | number>): string[] {
  return Object.keys(enumData)
    .filter((v) => isNaN(Number(v)) && v !== 'None')
    .map(Case.kebab);
}

/**
<<<<<<< HEAD
=======
 * The compilerOptions in the programmatic API are slightly differently than the format used in tsconfig.json
 * This helper performs the necessary conversion from the programmatic API format the one used in tsconfig.json
 *
 * @param opt compilerOptions in programmatic API format
 * @returns compilerOptions ready to be written on disk
 */
export function convertForJson(opt: ts.CompilerOptions): ts.CompilerOptions {
  // TypeScript's config parser attaches internal `pathsBasePath` when `paths` is set;
  // drop it so JSON serialization and tsconfig validation only see user-facing options.
  const rest = { ...opt };
  delete rest.pathsBasePath;

  return {
    ...rest,

    // Drop the "lib." prefix and ".d.ts" suffix before writing up the tsconfig.json file
    ...valueHelper('lib', opt.lib, convertLibForJson),

    // Re-write the module, targets & jsx to be the JSON format instead of Programmatic API
    ...enumHelper('importsNotUsedAsValues', opt.importsNotUsedAsValues, ts.ImportsNotUsedAsValues),
    ...valueHelper('jsx', opt.jsx, convertJsxForJson),
    ...enumHelper('module', opt.module, ts.ModuleKind),
    ...enumHelper('moduleResolution', opt.moduleResolution, ts.ModuleResolutionKind),
    ...enumHelper('moduleDetection', opt.moduleDetection, ts.ModuleDetectionKind),
    ...valueHelper('target', opt.target, convertScriptTargetForJson),

    // rewrite newline to be the JSON format instead of Programmatic API
    ...valueHelper('newLine', opt.newLine, convertNewLineForJson),
  };
}

function valueHelper<T, U>(
  name: string,
  value: T | undefined,
  converter: (value: T) => U,
): {
  [name: string]: U;
} {
  if (!value) {
    return {};
  }
  return { [name]: converter(value) };
}

function enumHelper<T>(
  name: string,
  value: any,
  enumObj: T,
  converter?: (value: string) => string,
): {
  [name: string]: string;
} {
  if (!value) {
    return {};
  }
  return { [name]: convertEnumToJson(value, enumObj, converter) };
}

/**
 * Convert an internal enum value to what a user would write in tsconfig.json
 * Possibly using a converter function to adjust casing.
 * @param value The internal enum value
 * @param enumObj The enum object to convert from
 * @param converter The converter function, defaults to lowercase
 * @returns The humanized version of the enum value
 */
export function convertEnumToJson<T>(
  value: keyof T,
  enumObj: T,
  converter: (value: string) => string = (v) => v.toLowerCase(),
): string {
  return converter(enumObj[value] as any);
}

/**
>>>>>>> a40b157 (fix(tsconfig): write jsx and target using their tsconfig spellings (#2990) (#3169))
 * Convert the internal lib strings to what a user would write in tsconfig.json
 * @param input The input libs array
 * @returns The humanized version lib array
 */
export function convertLibForJson(input: string[]): string[] {
  return input.map((lib) => lib.slice(4, lib.length - 5));
}

/**
 * Map the "compiler API version" of the new line setting (the numeric value of
 * the classic `ts.NewLineKind`) to the "tsconfig.json version".
 *
 * @param newLine the compiler form of the new line configuration
 *
 * @return the equivalent value to put in tsconfig.json
 */
export function convertNewLineForJson(newLine: 0 | 1): string {
  switch (newLine) {
    case 0: // ts.NewLineKind.CarriageReturnLineFeed
      return 'crlf';
    case 1: // ts.NewLineKind.LineFeed
      return 'lf';
  }
}

/**
<<<<<<< HEAD
 * Converts compiler options as TypeScript's config parser returns them (enum
 * values as numbers, `lib` as file names) to the form a user writes in
 * `tsconfig.json`, which is the form the rule sets are written against. Values
 * already in that form (such as {@link BASE_COMPILER_OPTIONS}) are kept.
 *
 * Like the classic compiler, enum values are named after their TypeScript enum
 * member: lower case, or kebab case for `jsx`. That gives `target: "latest"` for
 * `esnext` and `jsx: "react-js-x"` for `react-jsx` (aws/jsii-compiler#2990).
 */
// @TODO(NEXT): `esnext` and `react-jsx(dev)` get wrong names, as on main (aws/jsii-compiler#2990). After 7.1's first
// release: name them as tsconfig.json spells them (`esnext`, `react-jsx`, `react-jsxdev`).
export function convertForJson(opt: CompilerOptionsJson): CompilerOptionsJson {
  // TypeScript's config parser attaches internal `pathsBasePath` when `paths` is set;
  // drop it so JSON serialization and tsconfig validation only see user-facing options.
  const rest = { ...opt };
  delete rest.pathsBasePath;

  return {
    ...rest,
    // `lib.es2022.d.ts` -> `es2022`
    ...convertHelper('lib', opt.lib, (lib) =>
      Array.isArray(lib) ? lib.map((l) => (typeof l === 'string' ? l.replace(/^lib\.(.*)\.d\.ts$/, '$1') : l)) : lib,
    ),
    ...convertHelper('jsx', opt.jsx, (v) => enumName(v, 'JsxEmit', Case.kebab)),
    ...convertHelper('module', opt.module, (v) => enumName(v, 'ModuleKind')),
    ...convertHelper('moduleResolution', opt.moduleResolution, (v) => enumName(v, 'ModuleResolutionKind')),
    ...convertHelper('moduleDetection', opt.moduleDetection, (v) => enumName(v, 'ModuleDetectionKind')),
    ...convertHelper('target', opt.target, (v) => (v === 1 ? 'es5' : enumName(v, 'ScriptTarget'))),
    ...convertHelper('newLine', opt.newLine, (v) => enumName(v, 'NewLineKind')),
  };
}

/** Converts the value of one option; like the classic compiler, a falsy value (`module: 0`) is kept as it is. */
function convertHelper(name: string, value: unknown, converter: (value: unknown) => unknown): CompilerOptionsJson {
  if (!value) {
    return {};
  }
  return { [name]: converter(value) };
}

/**
 * The name of the TypeScript 7 enum member for a numeric value (`NewLineKind`
 * names are `CRLF` and `LF`). Other values are kept. TypeScript 7 has no `ES5`
 * target, but its parser still takes `target: "es5"` (value 1): the caller names it.
 */
function enumName(
  value: unknown,
  kind: 'JsxEmit' | 'ModuleKind' | 'ModuleResolutionKind' | 'ModuleDetectionKind' | 'ScriptTarget' | 'NewLineKind',
  converter = (v: string) => v.toLowerCase(),
): unknown {
  if (typeof value !== 'number') {
    return value;
  }
  const name = loadTypeScriptApi()[kind][value];
  return typeof name === 'string' ? converter(name) : value;
=======
 * This is annoying - the values expected in the tsconfig.json file are not
 * the same as the enum constant names, or their values. So we need this
 * function to map the "compiler API version" to the "tsconfig.json version"
 *
 * @param jsx the compiler form of the jsx configuration
 *
 * @return the equivalent value to put in tsconfig.json
 */
export function convertJsxForJson(jsx: ts.JsxEmit): string {
  switch (jsx) {
    case ts.JsxEmit.None:
      return 'none';
    case ts.JsxEmit.Preserve:
      return 'preserve';
    case ts.JsxEmit.React:
      return 'react';
    case ts.JsxEmit.ReactNative:
      return 'react-native';
    case ts.JsxEmit.ReactJSX:
      return 'react-jsx';
    case ts.JsxEmit.ReactJSXDev:
      return 'react-jsxdev';
  }
}

/**
 * This is annoying - the values expected in the tsconfig.json file are not
 * the same as the enum constant names, or their values. So we need this
 * function to map the "compiler API version" to the "tsconfig.json version"
 *
 * @param target the compiler form of the target configuration
 *
 * @return the equivalent value to put in tsconfig.json
 */
export function convertScriptTargetForJson(target: ts.ScriptTarget): string {
  switch (target) {
    case ts.ScriptTarget.ES3:
      return 'es3';
    case ts.ScriptTarget.ES5:
      return 'es5';
    case ts.ScriptTarget.ES2015:
      return 'es2015';
    case ts.ScriptTarget.ES2016:
      return 'es2016';
    case ts.ScriptTarget.ES2017:
      return 'es2017';
    case ts.ScriptTarget.ES2018:
      return 'es2018';
    case ts.ScriptTarget.ES2019:
      return 'es2019';
    case ts.ScriptTarget.ES2020:
      return 'es2020';
    case ts.ScriptTarget.ES2021:
      return 'es2021';
    case ts.ScriptTarget.ES2022:
      return 'es2022';
    case ts.ScriptTarget.ES2023:
      return 'es2023';
    case ts.ScriptTarget.ES2024:
      return 'es2024';
    // `ESNext` and `Latest` are the same target; `Latest` is the name the
    // reverse mapping of the enum returns, but users write `esnext`.
    case ts.ScriptTarget.ESNext:
    case ts.ScriptTarget.Latest:
      return 'esnext';
    default:
      return ts.ScriptTarget[target].toLowerCase();
  }
>>>>>>> a40b157 (fix(tsconfig): write jsx and target using their tsconfig spellings (#2990) (#3169))
}
