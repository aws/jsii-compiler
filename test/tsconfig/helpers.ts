import * as fs from 'node:fs';
import * as path from 'node:path';
import fc from 'fast-check';
import * as ts from 'typescript';
import { TypeScriptConfig } from '../../src/tsconfig';
import {
  convertLibForJson,
  convertNewLineForJson,
  enumAsKebab,
  enumAsLower,
} from '../../src/tsconfig/compiler-options';
import { RuleSet, RuleType } from '../../src/tsconfig/validator';

/**
 * An arbitrary but realistic TypeScriptConfig that matched the provided rule set.
 *
 * @param options - An object containing the properties used to generated an arbitrary tsconfig.
 * @returns A TypeScriptConfig arbitrary.
 */
export function fcTsconfigRealistic(rules: RuleSet = new RuleSet(), _options: {} = {}) {
  return fcTsconfig({
    compilerRuleSet: rules,
    compilerArbs: {
      // jsii does not care about this values
      // however they need to match the file system
      // for testing purposes we skip them
      rootDir: fc.constant(undefined),
      types: fc.constant(undefined),
      paths: fc.constant(undefined),
      baseUrl: fc.constant(undefined),

      // We are not testing incremental or composite builds
      tsBuildInfoFile: fc.constant(undefined),
      incremental: fc.constant(false),
      composite: fc.constant(false),

      // Not interested in testing sourcemaps
      sourceMap: fc.constant(undefined),
      inlineSourceMap: fc.constant(undefined),
      inlineSources: fc.constant(undefined),

      // Deprecated option
      prepend: fc.constant(undefined),
    },
    typeAcquisition: false,
    references: false,
    watchArbs: {
      excludeDirectories: fc.constant([]),
      excludeFiles: fc.constant([]),
    },
  });
}

/**
 * A TypeScriptConfig arbitrary.
 *
 * @param options - An object containing the properties used to generated an arbitrary tsconfig.
 * @returns A TypeScriptConfig arbitrary.
 */
export function fcTsconfig(
  options: {
    /**
     * Make sure generated options adhere to the rule set
     */
    compilerRuleSet?: RuleSet;
    /**
     * Explicitly define some arbitraries for compilerOptions
     */
    compilerArbs?: RecordModel<Partial<ts.CompilerOptions>>;
    /**
     * Explicitly define some arbitraries for watchOptions
     */
    watchArbs?: RecordModel<Partial<ts.WatchOptions>>;
    /**
     * Include typeAcquisition
     * @default false
     */
    typeAcquisition?: boolean;
    /**
     * Include references
     * @default true
     */
    references?: boolean;
  } = {},
): fc.Arbitrary<TypeScriptConfig> {
  const compilerOptionsModel: RecordModel<Required<ts.CompilerOptions>> = {
    allowImportingTsExtensions: fc.boolean(),
    allowJs: fc.boolean(),
    allowArbitraryExtensions: fc.boolean(),
    allowSyntheticDefaultImports: fc.boolean(),
    allowUmdGlobalAccess: fc.boolean(),
    allowUnreachableCode: fc.boolean(),
    allowUnusedLabels: fc.boolean(),
    alwaysStrict: fc.boolean(),
    baseUrl: fc.string(),
    charset: fc.string(),
    checkJs: fc.boolean(),
    customConditions: fc.array(fc.string()),
    declaration: fc.boolean(),
    declarationMap: fc.boolean(),
    emitDeclarationOnly: fc.boolean(),
    declarationDir: fc.string(),
    disableSizeLimit: fc.boolean(),
    disableSourceOfProjectReferenceRedirect: fc.boolean(),
    disableSolutionSearching: fc.boolean(),
    disableReferencedProjectLoad: fc.boolean(),
    downlevelIteration: fc.boolean(),
    emitBOM: fc.boolean(),
    emitDecoratorMetadata: fc.boolean(),
    exactOptionalPropertyTypes: fc.boolean(),
    experimentalDecorators: fc.boolean(),
    forceConsistentCasingInFileNames: fc.boolean(),
    ignoreDeprecations: fc.string(),
    importHelpers: fc.boolean(),
    importsNotUsedAsValues: fc.constantFrom(...(enumAsLower(ts.ImportsNotUsedAsValues) as any)),
    inlineSourceMap: fc.boolean(),
    inlineSources: fc.boolean(),
    isolatedModules: fc.boolean(),
    jsx: fc.constantFrom(...(enumAsKebab(ts.JsxEmit) as any)),
    keyofStringsOnly: fc.boolean(),
    lib: fc.uniqueArray(fc.constantFrom(...convertLibForJson(TS_LIBS))),
    locale: fc.string(),
    mapRoot: fc.string(),
    maxNodeModuleJsDepth: fc.nat(),
    module: fc.constantFrom(...(enumAsLower(ts.ModuleKind) as any)),
    moduleResolution: fc.constantFrom(...(enumAsLower(ts.ModuleResolutionKind).filter((r) => r !== 'nodejs') as any)), // remove deprecated value
    moduleSuffixes: fc.array(fc.string()),
    moduleDetection: fc.constantFrom(...(enumAsLower(ts.ModuleDetectionKind) as any)),
    newLine: fc.constantFrom(
      // Newline has a special conversion
      ...([ts.NewLineKind.CarriageReturnLineFeed, ts.NewLineKind.LineFeed].map(convertNewLineForJson) as any),
    ),
    noEmit: fc.boolean(),
    noEmitHelpers: fc.boolean(),
    noEmitOnError: fc.boolean(),
    noErrorTruncation: fc.boolean(),
    noFallthroughCasesInSwitch: fc.boolean(),
    noImplicitAny: fc.boolean(),
    noImplicitReturns: fc.boolean(),
    noImplicitThis: fc.boolean(),
    noStrictGenericChecks: fc.boolean(),
    noUnusedLocals: fc.boolean(),
    noUnusedParameters: fc.boolean(),
    noImplicitUseStrict: fc.boolean(),
    noPropertyAccessFromIndexSignature: fc.boolean(),
    assumeChangesOnlyAffectDirectDependencies: fc.boolean(),
    noLib: fc.boolean(),
    noResolve: fc.boolean(),
    noUncheckedIndexedAccess: fc.boolean(),
    out: fc.string(),
    outDir: fc.string(),
    outFile: fc.string(),
    paths: fc.dictionary(fc.string(), fc.array(fc.string())),
    preserveConstEnums: fc.boolean(),
    noImplicitOverride: fc.boolean(),
    preserveSymlinks: fc.boolean(),
    preserveValueImports: fc.boolean(),
    project: fc.string(),
    reactNamespace: fc.string(),
    jsxFactory: fc.string(),
    jsxFragmentFactory: fc.string(),
    jsxImportSource: fc.string(),
    composite: fc.boolean(),
    incremental: fc.boolean(),
    tsBuildInfoFile: fc.string(),
    removeComments: fc.boolean(),
    resolvePackageJsonExports: fc.boolean(),
    resolvePackageJsonImports: fc.boolean(),
    rootDir: fc.string(),
    rootDirs: fc.array(fc.string()),
    skipLibCheck: fc.boolean(),
    skipDefaultLibCheck: fc.boolean(),
    sourceMap: fc.boolean(),
    sourceRoot: fc.string(),
    strict: fc.boolean(),
    strictFunctionTypes: fc.boolean(),
    strictBindCallApply: fc.boolean(),
    strictNullChecks: fc.boolean(),
    strictPropertyInitialization: fc.boolean(),
    stripInternal: fc.boolean(),
    suppressExcessPropertyErrors: fc.boolean(),
    suppressImplicitAnyIndexErrors: fc.boolean(),
    target: fc.constantFrom(...(enumAsLower(ts.ScriptTarget).filter((t) => t !== 'json') as any)), // json target is not supported
    traceResolution: fc.boolean(),
    useUnknownInCatchVariables: fc.boolean(),
    resolveJsonModule: fc.boolean(),
    types: fc.array(fc.string()),
    typeRoots: fc.array(fc.string()),
    verbatimModuleSyntax: fc.boolean(),
    esModuleInterop: fc.boolean(),
    useDefineForClassFields: fc.boolean(),
  };

  // limit to only allowed keys
  const allowedKeys = options.compilerRuleSet?.allowedFields ?? [];

  // prevent required options from being dropped
  const requiredKeys = findRequiredKeysFromRuleSet(options.compilerRuleSet) ?? [];

  const watchOptionsModel: RecordModel<Required<ts.WatchOptions>> = {
    watchFile: fc.constantFrom(...(enumAsLower(ts.WatchFileKind) as any)),
    watchDirectory: fc.constantFrom(...(enumAsLower(ts.WatchDirectoryKind) as any)),
    fallbackPolling: fc.constantFrom(...(enumAsLower(ts.PollingWatchKind) as any)),
    synchronousWatchDirectory: fc.boolean(),
    excludeDirectories: fc.array(fc.string()),
    excludeFiles: fc.array(fc.string()),
  };

  return fc.record(
    {
      files: fc.array(fc.string()),
      extends: fc.oneof(fc.string(), fc.array(fc.string())),
      include: fc.array(fc.string()),
      exclude: fc.array(fc.string()),
      references:
        options.references ?? true
          ? fc.array(
              fc.record(
                {
                  path: fc.string(),
                  originalPath: fc.string(),
                  prepend: fc.boolean(),
                  circular: fc.boolean(),
                },
                {
                  requiredKeys: ['path'],
                },
              ),
            )
          : fc.constant(undefined),
      compilerOptions: fc.record(
        filterArbsByRuleSet(
          filterModelKeys(
            {
              ...compilerOptionsModel, // base arbitraries
              ...constantsFromRuleSet(options.compilerRuleSet), // derived constants from the rule set
              ...(options.compilerArbs || {}), // explicitly set arbitraries
            },
            allowedKeys,
          ),
          options.compilerRuleSet,
        ),
        {
          requiredKeys,
        },
      ),
      watchOptions: fc.record(
        {
          ...watchOptionsModel, // base arbitraries
          ...(options.watchArbs || {}), // explicitly set arbitraries
        },
        { withDeletedKeys: true },
      ),

      // typeAcquisition is usually not relevant for this project, so it is disabled by default
      ...(options.typeAcquisition
        ? {
            typeAcquisition: fc.record(
              {
                enable: fc.boolean(),
                include: fc.array(fc.string()),
                exclude: fc.array(fc.string()),
                disableFilenameBasedTypeAcquisition: fc.boolean(),
              },
              { withDeletedKeys: true },
            ),
          }
        : {}),
    },
    {
      requiredKeys: ['compilerOptions'],
    },
  ) as any;
}

type RecordModel<T> = {
  [K in keyof T]: fc.Arbitrary<T[K]>;
};

function constantsFromRuleSet<T>(rules: RuleSet = new RuleSet()): Record<string, fc.Arbitrary<T>> {
  const result: Record<string, fc.Arbitrary<T>> = {};
  const fieldHints = rules.getFieldHints();
  for (const [field, values] of Object.entries(fieldHints)) {
    if (values && Array.isArray(values) && values.length >= 1) {
      result[field] = fc.constantFrom(...values);
    }
  }

  return result;
}

/**
 * Find all required keys by evaluating every rule in th set against undefined.
 * If the rule fails, the key must be required.
 *
 * @param rules The rule set to test against
 * @returns A list of keys that must be included
 */
function findRequiredKeysFromRuleSet(rules: RuleSet = new RuleSet()): string[] {
  const required: string[] = [];

  for (const rule of rules.rules) {
    const key = rule.field;
    const matcherResult = rule.matcher(undefined);

    switch (rule.type) {
      case RuleType.PASS:
        if (!matcherResult) {
          required.push(key);
        }
        break;
      case RuleType.FAIL:
        if (matcherResult) {
          required.push(key);
        }
        break;
      default:
        continue;
    }
  }

  return required;
}

function filterArbsByRuleSet<T>(arbs: RecordModel<T>, rules: RuleSet = new RuleSet()): RecordModel<T> {
  for (const rule of rules.rules) {
    if ((rule.field as keyof typeof arbs) in arbs) {
      const key: keyof typeof arbs = rule.field as any;
      switch (rule.type) {
        case RuleType.PASS:
          arbs[key] = arbs[key].filter((v: any) => rule.matcher(v));
          break;
        case RuleType.FAIL:
          arbs[key] = arbs[key].filter((v: any) => !rule.matcher(v));
          break;
        default:
          continue;
      }
    }
  }

  return arbs;
}

function filterModelKeys<T>(arbs: RecordModel<T>, keepOnly?: string[]): RecordModel<T> {
  // if no keep is provided, return all keys
  if (keepOnly === undefined) {
    return arbs;
  }

  const r = Object.fromEntries(
    Object.entries(arbs).filter(([key]) => keepOnly?.includes(key) ?? true),
  ) as RecordModel<T>;

  return r;
}

function tsLibs(): string[] {
  const libdir = path.dirname(require.resolve('typescript'));
  const allFiles = fs.readdirSync(libdir);
  return allFiles.filter((file) => file.startsWith('lib.') && file.endsWith('.d.ts') && file !== 'lib.d.ts');
}

const TS_LIBS = tsLibs();
