import * as Case from '../case';
import type { CompilerOptionsJson } from './index';

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

/** Options whose string values TypeScript matches case-insensitively. */
const CASE_INSENSITIVE_OPTIONS = [
  'target',
  'module',
  'moduleResolution',
  'moduleDetection',
  'jsx',
  'newLine',
  'importsNotUsedAsValues',
];

/** Spellings TypeScript accepts as aliases of a canonical value. */
const VALUE_ALIASES: { [option: string]: { [alias: string]: string } } = {
  target: { es6: 'es2015' },
  module: { es6: 'es2015' },
  moduleResolution: { node: 'node10' },
};

/**
 * Normalizes compiler options read from a `tsconfig.json` to the canonical
 * spelling the rule sets are written against: TypeScript matches enum-valued
 * options (`target`, `module`, `lib`, ...) case-insensitively and accepts a few
 * aliases, so `"ES2022"` and `"es2022"` configure the same compilation. The
 * classic in-process parser performed this normalization implicitly; TypeScript 7
 * parses the file on the server, so jsii applies the same rules here before
 * validating or writing options.
 */
export function convertForJson(opt: CompilerOptionsJson): CompilerOptionsJson {
  const out: CompilerOptionsJson = { ...opt };
  for (const name of CASE_INSENSITIVE_OPTIONS) {
    const value = out[name];
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      out[name] = VALUE_ALIASES[name]?.[lower] ?? lower;
    }
  }
  if (Array.isArray(out.lib)) {
    out.lib = out.lib.map((lib) =>
      typeof lib === 'string'
        ? lib
            .toLowerCase()
            .replace(/^lib\./, '')
            .replace(/\.d\.ts$/, '')
        : lib,
    );
  }
  return out;
}
