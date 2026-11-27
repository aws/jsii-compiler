/**
 * The compiler options the classic compiler (TypeScript 6.0.3) accepts in a
 * tsconfig, with the type of value each takes: TypeScript's own
 * `optionDeclarations`. Command-line-only options take no value in a tsconfig.
 *
 * The classic compiler validated and compiled the options as TypeScript parsed
 * them, which drops unknown options and values of the wrong type. TypeScript 7
 * parses on the server and knows a different set of options, so jsii keeps this
 * copy to drop the same options.
 *
 * shortcut: a copy of TypeScript 6.0.3's table; refresh it when main moves to another TypeScript version.
 * Produced from `require('typescript').optionDeclarations` (`name`, `type`, `element.type`, `isCommandLineOnly`).
 */

// @TODO(NEXT): this file pins TypeScript 6.0.3's option table only to copy main (aws/jsii-compiler#3029); TS7 knows
// other options. After 7.1's first release: delete it and let TS7's own parse errors speak.
/** A value type: a primitive, the accepted values of an enum, a list of either, or none (command line only). */
export type ClassicOptionType =
  | 'commandLineOnly'
  | 'boolean'
  | 'string'
  | 'number'
  | 'object'
  | readonly string[]
  | { readonly list: ClassicOptionType };

// prettier-ignore
const LIB = ['es5', 'es6', 'es2015', 'es7', 'es2016', 'es2017', 'es2018', 'es2019', 'es2020', 'es2021', 'es2022', 'es2023', 'es2024', 'es2025', 'esnext', 'dom', 'dom.iterable', 'dom.asynciterable', 'webworker', 'webworker.importscripts', 'webworker.iterable', 'webworker.asynciterable', 'scripthost', 'es2015.core', 'es2015.collection', 'es2015.generator', 'es2015.iterable', 'es2015.promise', 'es2015.proxy', 'es2015.reflect', 'es2015.symbol', 'es2015.symbol.wellknown', 'es2016.array.include', 'es2016.intl', 'es2017.arraybuffer', 'es2017.date', 'es2017.object', 'es2017.sharedmemory', 'es2017.string', 'es2017.intl', 'es2017.typedarrays', 'es2018.asyncgenerator', 'es2018.asynciterable', 'es2018.intl', 'es2018.promise', 'es2018.regexp', 'es2019.array', 'es2019.object', 'es2019.string', 'es2019.symbol', 'es2019.intl', 'es2020.bigint', 'es2020.date', 'es2020.promise', 'es2020.sharedmemory', 'es2020.string', 'es2020.symbol.wellknown', 'es2020.intl', 'es2020.number', 'es2021.promise', 'es2021.string', 'es2021.weakref', 'es2021.intl', 'es2022.array', 'es2022.error', 'es2022.intl', 'es2022.object', 'es2022.string', 'es2022.regexp', 'es2023.array', 'es2023.collection', 'es2023.intl', 'es2024.arraybuffer', 'es2024.collection', 'es2024.object', 'es2024.promise', 'es2024.regexp', 'es2024.sharedmemory', 'es2024.string', 'es2025.collection', 'es2025.float16', 'es2025.intl', 'es2025.iterator', 'es2025.promise', 'es2025.regexp', 'esnext.asynciterable', 'esnext.symbol', 'esnext.bigint', 'esnext.weakref', 'esnext.object', 'esnext.regexp', 'esnext.string', 'esnext.float16', 'esnext.iterator', 'esnext.promise', 'esnext.array', 'esnext.collection', 'esnext.date', 'esnext.decorators', 'esnext.disposable', 'esnext.error', 'esnext.intl', 'esnext.sharedmemory', 'esnext.temporal', 'esnext.typedarrays', 'decorators', 'decorators.legacy'];

// prettier-ignore
export const CLASSIC_COMPILER_OPTIONS: { readonly [name: string]: ClassicOptionType } = {
  help: 'commandLineOnly',
  watch: 'commandLineOnly',
  locale: 'commandLineOnly',
  showConfig: 'commandLineOnly',
  listFilesOnly: 'commandLineOnly',
  ignoreConfig: 'commandLineOnly',
  preserveWatchOutput: 'boolean',
  listFiles: 'boolean',
  explainFiles: 'boolean',
  listEmittedFiles: 'boolean',
  pretty: 'boolean',
  traceResolution: 'boolean',
  diagnostics: 'boolean',
  extendedDiagnostics: 'boolean',
  generateCpuProfile: 'string',
  generateTrace: 'string',
  incremental: 'boolean',
  declaration: 'boolean',
  declarationMap: 'boolean',
  emitDeclarationOnly: 'boolean',
  sourceMap: 'boolean',
  inlineSourceMap: 'boolean',
  noCheck: 'boolean',
  noEmit: 'boolean',
  assumeChangesOnlyAffectDirectDependencies: 'boolean',
  all: 'boolean',
  version: 'boolean',
  init: 'boolean',
  project: 'string',
  target: ['es3', 'es5', 'es6', 'es2015', 'es2016', 'es2017', 'es2018', 'es2019', 'es2020', 'es2021', 'es2022', 'es2023', 'es2024', 'es2025', 'esnext'],
  module: ['none', 'commonjs', 'amd', 'system', 'umd', 'es6', 'es2015', 'es2020', 'es2022', 'esnext', 'node16', 'node18', 'node20', 'nodenext', 'preserve'],
  lib: { list: LIB },
  allowJs: 'boolean',
  checkJs: 'boolean',
  jsx: ['preserve', 'react-native', 'react-jsx', 'react-jsxdev', 'react'],
  outFile: 'string',
  outDir: 'string',
  rootDir: 'string',
  composite: 'boolean',
  tsBuildInfoFile: 'string',
  removeComments: 'boolean',
  importHelpers: 'boolean',
  importsNotUsedAsValues: ['remove', 'preserve', 'error'],
  downlevelIteration: 'boolean',
  isolatedModules: 'boolean',
  verbatimModuleSyntax: 'boolean',
  isolatedDeclarations: 'boolean',
  erasableSyntaxOnly: 'boolean',
  libReplacement: 'boolean',
  strict: 'boolean',
  noImplicitAny: 'boolean',
  strictNullChecks: 'boolean',
  strictFunctionTypes: 'boolean',
  strictBindCallApply: 'boolean',
  strictPropertyInitialization: 'boolean',
  strictBuiltinIteratorReturn: 'boolean',
  stableTypeOrdering: 'boolean',
  noImplicitThis: 'boolean',
  useUnknownInCatchVariables: 'boolean',
  alwaysStrict: 'boolean',
  noUnusedLocals: 'boolean',
  noUnusedParameters: 'boolean',
  exactOptionalPropertyTypes: 'boolean',
  noImplicitReturns: 'boolean',
  noFallthroughCasesInSwitch: 'boolean',
  noUncheckedIndexedAccess: 'boolean',
  noImplicitOverride: 'boolean',
  noPropertyAccessFromIndexSignature: 'boolean',
  moduleResolution: ['node10', 'node', 'classic', 'node16', 'nodenext', 'bundler'],
  baseUrl: 'string',
  paths: 'object',
  rootDirs: { list: 'string' },
  typeRoots: { list: 'string' },
  types: { list: 'string' },
  allowSyntheticDefaultImports: 'boolean',
  esModuleInterop: 'boolean',
  preserveSymlinks: 'boolean',
  allowUmdGlobalAccess: 'boolean',
  moduleSuffixes: { list: 'string' },
  allowImportingTsExtensions: 'boolean',
  rewriteRelativeImportExtensions: 'boolean',
  resolvePackageJsonExports: 'boolean',
  resolvePackageJsonImports: 'boolean',
  customConditions: { list: 'string' },
  noUncheckedSideEffectImports: 'boolean',
  sourceRoot: 'string',
  mapRoot: 'string',
  inlineSources: 'boolean',
  experimentalDecorators: 'boolean',
  emitDecoratorMetadata: 'boolean',
  jsxFactory: 'string',
  jsxFragmentFactory: 'string',
  jsxImportSource: 'string',
  resolveJsonModule: 'boolean',
  allowArbitraryExtensions: 'boolean',
  out: 'string',
  reactNamespace: 'string',
  skipDefaultLibCheck: 'boolean',
  charset: 'string',
  emitBOM: 'boolean',
  newLine: ['crlf', 'lf'],
  noErrorTruncation: 'boolean',
  noLib: 'boolean',
  noResolve: 'boolean',
  stripInternal: 'boolean',
  disableSizeLimit: 'boolean',
  disableSourceOfProjectReferenceRedirect: 'boolean',
  disableSolutionSearching: 'boolean',
  disableReferencedProjectLoad: 'boolean',
  noImplicitUseStrict: 'boolean',
  noEmitHelpers: 'boolean',
  noEmitOnError: 'boolean',
  preserveConstEnums: 'boolean',
  declarationDir: 'string',
  skipLibCheck: 'boolean',
  allowUnusedLabels: 'boolean',
  allowUnreachableCode: 'boolean',
  suppressExcessPropertyErrors: 'boolean',
  suppressImplicitAnyIndexErrors: 'boolean',
  forceConsistentCasingInFileNames: 'boolean',
  maxNodeModuleJsDepth: 'number',
  noStrictGenericChecks: 'boolean',
  useDefineForClassFields: 'boolean',
  preserveValueImports: 'boolean',
  keyofStringsOnly: 'boolean',
  plugins: { list: 'object' },
  moduleDetection: ['auto', 'legacy', 'force'],
  ignoreDeprecations: 'string',
};

/**
 * Drops what TypeScript 6 rejects when it reads a tsconfig, as its
 * `convertCompilerOptionsFromJson` does. Unknown options are removed. A known
 * option that is command line only, or has `null`, a value of the wrong type or one not
 * among an enum's values (matched case-insensitively) is kept as `undefined`, so
 * it still overrides the same option of an `extends` base. Such list elements are
 * removed. Accepted values are kept as written.
 *
 * shortcut: TypeScript keeps a rejected `moduleSuffixes` element as `undefined`; it is removed here.
 */
export function dropRejectedOptions(options: { readonly [name: string]: any }): { [name: string]: any } {
  const out: { [name: string]: any } = {};
  for (const [name, value] of Object.entries(options)) {
    const type = Object.prototype.hasOwnProperty.call(CLASSIC_COMPILER_OPTIONS, name)
      ? CLASSIC_COMPILER_OPTIONS[name]
      : undefined;
    if (type == null) {
      continue;
    }
    if (isList(type)) {
      out[name] = Array.isArray(value) ? value.filter((element) => accepts(type.list, element)) : undefined;
    } else {
      out[name] = accepts(type, value) ? value : undefined;
    }
  }
  return out;
}

function isList(type: ClassicOptionType): type is { readonly list: ClassicOptionType } {
  return typeof type === 'object' && !Array.isArray(type);
}

function accepts(type: ClassicOptionType, value: unknown): boolean {
  if (value == null || type === 'commandLineOnly') {
    return false;
  }
  if (Array.isArray(type)) {
    return typeof value === 'string' && type.includes(value.toLowerCase());
  }
  return typeof value === type;
}
