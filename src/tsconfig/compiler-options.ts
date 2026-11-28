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
 * Converts compiler options as TypeScript's config parser returns them (enum
 * values as numbers, `lib` as file names) to the form a user writes in
 * `tsconfig.json`, which is the form the rule sets are written against. Values
 * already in that form (such as {@link BASE_COMPILER_OPTIONS}) are kept.
 *
 * Enum values are named after their TypeScript enum member in lower case,
 * except `jsx` and `target`, which are written as tsconfig.json spells them.
 */
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
    ...convertHelper('jsx', opt.jsx, (v) => (typeof v === 'number' ? convertJsxForJson(v) : v)),
    ...convertHelper('module', opt.module, (v) => enumName(v, 'ModuleKind')),
    ...convertHelper('moduleResolution', opt.moduleResolution, (v) => enumName(v, 'ModuleResolutionKind')),
    ...convertHelper('moduleDetection', opt.moduleDetection, (v) => enumName(v, 'ModuleDetectionKind')),
    ...convertHelper('target', opt.target, (v) => (typeof v === 'number' ? convertScriptTargetForJson(v) : v)),
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
}

/**
 * The tsconfig.json spelling of a `jsx` value (the numeric `JsxEmit`). The enum
 * member names don't kebab-case to it: `ReactJSX` is written `react-jsx`.
 */
export function convertJsxForJson(jsx: number): string {
  switch (jsx) {
    case 0:
      return 'none';
    case 1:
      return 'preserve';
    case 2:
      return 'react';
    case 3:
      return 'react-native';
    case 4:
      return 'react-jsx';
    case 5:
      return 'react-jsxdev';
    default:
      return String(enumName(jsx, 'JsxEmit', Case.kebab));
  }
}

/**
 * The tsconfig.json spelling of a `target` value (the numeric `ScriptTarget`).
 * TypeScript 7 has no `ES3` and `ES5` members, but its parser still takes them,
 * and the enum names `ESNext` as `Latest`.
 */
export function convertScriptTargetForJson(target: number): string {
  switch (target) {
    case 0:
      return 'es3';
    case 1:
      return 'es5';
    case 99:
      return 'esnext';
    default:
      return String(enumName(target, 'ScriptTarget'));
  }
}
