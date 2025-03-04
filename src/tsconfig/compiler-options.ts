import * as ts from 'typescript';
import * as Case from '../case';

export const BASE_COMPILER_OPTIONS: ts.CompilerOptions = {
  alwaysStrict: true,
  declaration: true,
  experimentalDecorators: true,
  incremental: true,
  lib: ['lib.es2020.d.ts'],
  module: ts.ModuleKind.CommonJS,
  noEmitOnError: true,
  noFallthroughCasesInSwitch: true,
  noImplicitAny: true,
  noImplicitReturns: true,
  noImplicitThis: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  strict: true,
  strictNullChecks: true,
  strictPropertyInitialization: true,
  stripInternal: false,
  target: ts.ScriptTarget.ES2020,
};

/**
 * Helper function to convert a TS enum into a list of allowed values,
 * converting everything to camel case.
 * This is used for example for the watch options
 */
export function enumAsCamel(enumData: Record<string, string | number>): string[] {
  return Object.keys(enumData)
    .filter((v) => isNaN(Number(v)))
    .map(Case.camel);
}

/**
 * Helper function to convert a TS enum into a list of allowed values,
 * converting everything to lower case.
 * This is used for example for the "target" compiler option
 */
export function enumAsLower(enumData: Record<string, string | number>): string[] {
  return Object.keys(enumData)
    .filter((v) => isNaN(Number(v)) && v !== 'None')
    .map((v) => v.toLowerCase());
}

/**
 * Helper function to convert a TS enum into a list of allowed values,
 * converting everything to kebab case.
 * This is used for example for the "jsx" compiler option
 */
export function enumAsKebab(enumData: Record<string, string | number>): string[] {
  return Object.keys(enumData)
    .filter((v) => isNaN(Number(v)) && v !== 'None')
    .map(Case.kebab);
}

/**
 * The compilerOptions in the programmatic API are slightly differently than the format used in tsconfig.json
 * This helper performs the necessary conversion from the programmatic API format the one used in tsconfig.json
 *
 * @param opt compilerOptions in programmatic API format
 * @returns compilerOptions ready to be written on disk
 */
export function convertForJson(opt: ts.CompilerOptions): ts.CompilerOptions {
  return {
    ...opt,

    // Drop the "lib." prefix and ".d.ts" suffix before writing up the tsconfig.json file
    ...valueHelper('lib', opt.lib, convertLibForJson),

    // Re-write the module, targets & jsx to be the JSON format instead of Programmatic API
    ...enumHelper('importsNotUsedAsValues', opt.importsNotUsedAsValues, ts.ImportsNotUsedAsValues),
    ...enumHelper('jsx', opt.jsx, ts.JsxEmit, Case.kebab),
    ...enumHelper('module', opt.module, ts.ModuleKind),
    ...enumHelper('moduleResolution', opt.moduleResolution, ts.ModuleResolutionKind),
    ...enumHelper('moduleDetection', opt.moduleDetection, ts.ModuleDetectionKind),
    ...enumHelper('target', opt.target, ts.ScriptTarget),

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
 * Convert the internal lib strings to what a user would write in tsconfig.json
 * @param input The input libs array
 * @returns The humanized version lib array
 */
export function convertLibForJson(input: string[]): string[] {
  return input.map((lib) => lib.slice(4, lib.length - 5));
}

/**
 * This is annoying - the values expected in the tsconfig.json file are not
 * the same as the enum constant names, or their values. So we need this
 * function to map the "compiler API version" to the "tsconfig.json version"
 *
 * @param newLine the compiler form of the new line configuration
 *
 * @return the equivalent value to put in tsconfig.json
 */
export function convertNewLineForJson(newLine: ts.NewLineKind): string {
  switch (newLine) {
    case ts.NewLineKind.CarriageReturnLineFeed:
      return 'crlf';
    case ts.NewLineKind.LineFeed:
      return 'lf';
  }
}
