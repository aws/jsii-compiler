import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as spec from '@jsii/spec';
import { writeAssembly } from '@jsii/spec';
import chalk from 'chalk';
import * as log4js from 'log4js';

import { Assembler } from './assembler';
import { BackgroundCheck, BackgroundCheckResult, MIN_FILES_FOR_BACKGROUND_CHECK } from './background-check';
import { findDependencyDirectory } from './common/find-utils';
import { CompilerHost } from './compiler-host';
import { Diagnostic, DiagnosticCategory, flattenDiagnosticMessageText } from './diagnostic';
import { emitProject } from './emitter';
import { JsiiDiagnostic } from './jsii-diagnostic';
import * as literate from './literate';
import { ProjectInfo } from './project-info';
import { DeclarationsStripping, MergedDeclarationError } from './transforms/deprecated-remover';
import { DeprecationWarningsInjector, WARNINGSCODE_FILE_NAME } from './transforms/deprecation-warnings';
import { TypeScriptConfig, TypeScriptConfigValidationRuleSet } from './tsconfig';
import { BASE_COMPILER_OPTIONS, convertForJson, convertForTsconfigFile } from './tsconfig/compiler-options';
import { parseTsconfigJson, readTypeScriptConfigFile, TsconfigReadError } from './tsconfig/read';
import { TypeScriptConfigValidator } from './tsconfig/tsconfig-validator';
import { ValidationError } from './tsconfig/validator';
import * as utils from './utils';
import { isSilenced } from './warnings';

const LOG = log4js.getLogger('jsii/compiler');
export const DIAGNOSTICS = 'diagnostics';
export const JSII_DIAGNOSTICS_CODE = 9999;

export interface CompilerOptions {
  /** The information about the project to be built */
  projectInfo: ProjectInfo;
  /**
   * Whether the compiler should watch for changes or just compile once.
   *
   * Watch mode is not available on the TypeScript 7 backend; setting this to
   * `true` makes `emit()` fail with an explicit error.
   */
  watch?: boolean;
  /** Whether to detect and generate TypeScript project references */
  projectReferences?: boolean;
  /** Whether to fail when a warning is emitted */
  failOnWarnings?: boolean;
  /** Whether to strip deprecated members from emitted artifacts */
  stripDeprecated?: boolean;
  /** The path to an allowlist of FQNs to strip if stripDeprecated is set */
  stripDeprecatedAllowListFile?: string;
  /**
   * Whether to add warnings for deprecated elements.
   *
   * Writes the `.warnings.jsii.js` module and adds calls into it to the
   * emitted `.js`.
   */
  addDeprecationWarnings?: boolean;
  /**
   * The name of the tsconfig file to generate.
   * Cannot be used at the same time as `typeScriptConfig`.
   * @default "tsconfig.json"
   */
  generateTypeScriptConfig?: string;
  /**
   * The name of the tsconfig file to use.
   * Cannot be used at the same time as `generateTypeScriptConfig`.
   * @default - generate the tsconfig file
   */
  typeScriptConfig?: string;
  /**
   * The ruleset to validate the provided tsconfig file against.
   * Can only be used when `typeScriptConfig` is provided.
   * @default TypeScriptConfigValidationRuleSet.STRICT - if `typeScriptConfig` is provided
   */
  validateTypeScriptConfig?: TypeScriptConfigValidationRuleSet;
  /**
   * Whether to compress the assembly
   * @default false
   */
  compressAssembly?: boolean;
}

export interface EmitResult {
  readonly emitSkipped: boolean;
  readonly diagnostics: readonly Diagnostic[];
  /** The files written by the compiler (absolute paths). */
  readonly emittedFiles?: readonly string[];
}

/**
 * Compiles a jsii project with the TypeScript 7 programmatic API.
 *
 * The compiler owns the `tsconfig.json` handling (generating one from the
 * project's `package.json`, or validating a user-provided one) and delegates the
 * type analysis, assembly generation and emit to `buildProject`, which drives the
 * out-of-process TypeScript 7 compiler.
 */
export class Compiler {
  private readonly userProvidedTypeScriptConfig: boolean;
  private readonly tsconfig: TypeScriptConfig;
  /** Diagnostics about the TypeScript configuration, reported with those of every build. */
  private readonly configDiagnostics: Diagnostic[] = [];
  private readonly configPath: string;
  private readonly projectRoot: string;

  public constructor(private readonly options: CompilerOptions) {
    if (options.generateTypeScriptConfig != null && options.typeScriptConfig != null) {
      throw new utils.JsiiError(
        'Cannot use `generateTypeScriptConfig` and `typeScriptConfig` together. Provide only one of them.',
      );
    }

    this.projectRoot = this.options.projectInfo.projectRoot;
    const configFileName = options.typeScriptConfig ?? options.generateTypeScriptConfig ?? 'tsconfig.json';
    this.configPath = path.join(this.projectRoot, configFileName);
    this.userProvidedTypeScriptConfig = Boolean(options.typeScriptConfig);
    this.tsconfig = this.configureTypeScript();
  }

  /** The name of the tsconfig file this compiler builds from (relative to the project root). */
  public get configFileName(): string {
    return path.relative(this.projectRoot, this.configPath);
  }

  /**
   * Compiles the configured project once.
   */
  /**
   * Compiles the configured project once.
   *
   * @param files can be specified to override the standard source code location
   *              logic (the generated tsconfig then lists exactly these files).
   *              Useful for example when testing "negatives".
   */
  public emit(...files: string[]): EmitResult {
    if (this.options.watch) {
      throw new utils.JsiiError('--watch is not supported by the TypeScript 7 based compiler', true);
    }
    if (files.length > 0 && this.userProvidedTypeScriptConfig) {
      throw new utils.JsiiError('Explicit source files cannot be combined with a user-provided tsconfig');
    }
    if (!this.userProvidedTypeScriptConfig) {
      this.writeTypeScriptConfig(files);
    }

    const result = buildProject({
      projectRoot: this.projectRoot,
      projectInfo: this.options.projectInfo,
      tsconfigFileName: this.configFileName,
      generatedTsconfig: !this.userProvidedTypeScriptConfig,
      userTsconfig: this.userProvidedTypeScriptConfig ? this.tsconfig : undefined,
      stripDeprecated: this.options.stripDeprecated,
      stripDeprecatedAllowListFile: this.options.stripDeprecatedAllowListFile,
      addDeprecationWarnings: this.options.addDeprecationWarnings,
      compressAssembly: this.options.compressAssembly,
      failOnWarnings: this.options.failOnWarnings,
    });

    if (!result.emitSkipped) {
      LOG.info(`assembled ${result.typeCount} types, emitted ${result.emittedFiles.length} files`);
    }

    // Some extra validation on the config.
    // Make sure that { "./.warnings.jsii.js": "./.warnings.jsii.js" } is in the set of
    // exports, if they are specified.
    const diagnostics: Diagnostic[] = [...result.diagnostics, ...this.configDiagnostics];
    let missingWarningsExport = false;
    if (this.options.addDeprecationWarnings && this.options.projectInfo.exports !== undefined) {
      const expected = `./${WARNINGSCODE_FILE_NAME}`;
      const warningsExport = Object.entries(this.options.projectInfo.exports).filter(
        ([k, v]) => k === expected && v === expected,
      );

      if (warningsExport.length === 0) {
        missingWarningsExport = true;
        diagnostics.push(JsiiDiagnostic.JSII_0007_MISSING_WARNINGS_EXPORT.createDetached());
      }
    }

    const hasWarnings = diagnostics.some((d) => d.category === DiagnosticCategory.Warning && !isSilenced(d));
    return {
      emitSkipped: result.emitSkipped || missingWarningsExport || (this.options.failOnWarnings === true && hasWarnings),
      // Like the classic compiler: sorted and de-duplicated, TypeScript and jsii diagnostics together.
      diagnostics: sortAndDeduplicateDiagnostics(diagnostics),
      emittedFiles: result.emittedFiles,
    };
  }

  private configureTypeScript(): TypeScriptConfig {
    if (this.userProvidedTypeScriptConfig) {
      let config: TypeScriptConfig;
      try {
        // @TODO(NEXT): paths and `extends` of a --tsconfig in a subdirectory resolve against the project root, not the
        // file's own directory as tsc does (aws/jsii-compiler#2991). After 7.1's first release: drop the
        // `projectRoot` argument.
        config = readTypeScriptConfigFile(this.configPath, this.projectRoot);
      } catch (e) {
        if (!(e instanceof TsconfigReadError)) {
          throw e;
        }
        // Like the classic compiler: TypeScript's error, then a short one.
        utils.logDiagnostic(toDiagnostic(e.diagnostic, readSourceFile), this.projectRoot);
        throw new utils.JsiiError(`Failed to load tsconfig at ${this.configPath}`);
      }

      // emit a warning if validation is disabled
      const rules = this.options.validateTypeScriptConfig ?? TypeScriptConfigValidationRuleSet.NONE;
      if (rules === TypeScriptConfigValidationRuleSet.NONE) {
        this.configDiagnostics.push(
          JsiiDiagnostic.JSII_4009_DISABLED_TSCONFIG_VALIDATION.create(undefined, this.configPath),
        );
      }

      // validate the user provided config
      if (rules !== TypeScriptConfigValidationRuleSet.NONE) {
        const configName = path.relative(this.projectRoot, this.configPath);
        try {
          const validator = new TypeScriptConfigValidator(rules);
          validator.validate({
            ...config,
            // convert the internal format to the user format which is what the validator operates on
            compilerOptions: convertForJson(config.compilerOptions),
          });
        } catch (error: unknown) {
          if (error instanceof ValidationError) {
            utils.logDiagnostic(
              JsiiDiagnostic.JSII_4000_FAILED_TSCONFIG_VALIDATION.create(
                undefined,
                configName,
                rules,
                error.violations,
              ),
              this.projectRoot,
            );
          }

          throw new utils.JsiiError(
            `Failed validation of tsconfig "compilerOptions" in "${configName}" against rule set "${rules}"!`,
          );
        }
      }

      return config;
    }

    // generated config if none is provided by the user
    return this.buildTypeScriptConfig();
  }

  /**
   * Builds the TypeScript config object from jsii config.
   *
   * This is the object that will be written to disk unless an existing tsconfig
   * is passed in.
   */
  private buildTypeScriptConfig(): TypeScriptConfig {
    let references: string[] | undefined;

    const isComposite =
      this.options.projectReferences !== undefined
        ? this.options.projectReferences
        : this.options.projectInfo.projectReferences !== undefined
        ? this.options.projectInfo.projectReferences
        : false;

    if (isComposite) {
      references = this.findProjectReferences();
    }

    const pi = this.options.projectInfo;

    return {
      compilerOptions: {
        ...pi.tsc,
        ...BASE_COMPILER_OPTIONS,
        // Enable composite mode if project references are enabled
        composite: isComposite,
        // When incremental, configure a tsbuildinfo file
        tsBuildInfoFile: path.join(pi.tsc?.outDir ?? '.', 'tsconfig.tsbuildinfo'),
      },
      include: [pi.tsc?.rootDir != null ? path.join(pi.tsc.rootDir, '**', '*.ts') : path.join('**', '*.ts')],
      exclude: [
        'node_modules',
        ...(pi.excludeTypescript ?? []),
        ...(pi.tsc?.outDir != null &&
        (pi.tsc?.rootDir == null || path.resolve(pi.tsc.outDir).startsWith(path.resolve(pi.tsc.rootDir) + path.sep))
          ? [path.join(pi.tsc.outDir, '**', '*.ts')]
          : []),
      ],
      // Change the references a little. We write 'originalpath' to the
      // file under the 'path' key, which is the same as what the
      // TypeScript compiler does. Make it relative so that the files are
      // movable. Not strictly required but looks better.
      references: references?.map((p) => ({ path: p })),
    };
  }

  /**
   * Creates a `tsconfig.json` file to improve the IDE experience.
   */
  private writeTypeScriptConfig(files: string[] = []): void {
    const commentKey = '_generated_by_jsii_';
    const commentValue = 'Generated by jsii - safe to delete, and ideally should be in .gitignore';

    (this.tsconfig as any)[commentKey] = commentValue;

    if (fs.existsSync(this.configPath)) {
      const currentConfig = parseTsconfigJson(fs.readFileSync(this.configPath, 'utf8'), this.configPath);
      if (currentConfig && !(commentKey in currentConfig)) {
        throw new utils.JsiiError(
          `A '${this.configPath}' file that was not generated by jsii is in ${this.options.projectInfo.projectRoot}. Aborting instead of overwriting.`,
        );
      }
    }

    const config: TypeScriptConfig =
      files.length > 0
        ? {
            ...this.tsconfig,
            files: files.map((f) => path.relative(this.projectRoot, path.resolve(this.projectRoot, f))),
            include: undefined,
          }
        : this.tsconfig;
    LOG.debug(`Creating or updating ${chalk.blue(this.configPath)}`);
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  /**
   * Find all dependencies that look like TypeScript projects.
   *
   * Enumerate all dependencies, if they have a tsconfig.json file with
   * "composite: true" we consider them project references.
   *
   * (Note: TypeScript seems to only correctly find transitive project references
   * if there's an "index" tsconfig.json of all projects somewhere up the directory
   * tree)
   */
  private findProjectReferences(): string[] {
    const pkg = this.options.projectInfo.packageJson;

    const ret = new Array<string>();

    const dependencyNames = new Set<string>();
    for (const dependencyMap of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
      if (dependencyMap === undefined) {
        continue;
      }
      for (const name of Object.keys(dependencyMap)) {
        dependencyNames.add(name);
      }
    }

    for (const tsconfigFile of Array.from(dependencyNames).map((depName) => this.findMonorepoPeerTsconfig(depName))) {
      if (!tsconfigFile) {
        continue;
      }

      const tsconfig = parseTsconfigJson(fs.readFileSync(tsconfigFile, 'utf8'), tsconfigFile);

      // Add references to any TypeScript package we find that is 'composite' enabled.
      // Make it relative.
      if (tsconfig.compilerOptions?.composite) {
        ret.push(path.relative(this.options.projectInfo.projectRoot, path.dirname(tsconfigFile)));
      } else {
        // Not a composite package--if this package is in a 'node_modules' directory, that is most
        // likely correct, otherwise it is most likely an error (heuristic).
        if (tsconfigFile.includes('node_modules')) {
          LOG.warn('%s: not a composite TypeScript package, but it probably should be', path.dirname(tsconfigFile));
        }
      }
    }

    return ret;
  }

  /**
   * Find source files for a dependency that is also a sibling in a monorepo.
   *
   * This method is used to find project references.
   */
  private findMonorepoPeerTsconfig(depName: string): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { builtinModules } = require('node:module');
    if ((builtinModules ?? []).includes(depName)) {
      // Can happen for modules like 'punycode' which are declared as dependency for polyfill purposes
      return undefined;
    }

    try {
      const depDir = findDependencyDirectory(depName, this.options.projectInfo.projectRoot);

      const dep = path.join(depDir, 'tsconfig.json');
      if (!fs.existsSync(dep)) {
        return undefined;
      }

      // Resolve symlinks, to get a correct relative path
      const dependencyRealPath = fs.realpathSync(dep);
      if (dependencyRealPath.split(path.sep).includes('node_modules')) {
        return undefined;
      }

      return dependencyRealPath;
    } catch (e: any) {
      // @types modules cannot be required, for example
      if (['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(e.code)) {
        return undefined;
      }
      throw e;
    }
  }
}

/**
 * A copy of `value` with the keys of every object sorted, like `sort-json`. That one copies its options for every node
 * and sorts the indices of every array as text, filling the copy out of order (it took 4s of the 5s of the fingerprint
 * of aws-cdk-lib's assembly). The arrays here keep their order, which is all its result is for them.
 */
function sortJson(value: any): any {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  const copy: any = {};
  for (const key of Object.keys(value).sort()) {
    copy[key] = sortJson(value[key]);
  }
  return copy;
}

export interface BuildProjectOptions {
  readonly projectRoot: string;
  readonly projectInfo: ProjectInfo;
  /** The tsconfig file to open, relative to `projectRoot` (default `tsconfig.json`). */
  readonly tsconfigFileName?: string;
  /**
   * Whether the tsconfig was generated by jsii (as opposed to user-provided).
   * A generated config may be amended with an inferred `rootDir`.
   */
  readonly generatedTsconfig?: boolean;
  /**
   * The user-provided tsconfig as TypeScript's parser read it: `extends` resolved, bases that
   * cannot be read, parsed or that are circular skipped, rejected options left out.
   */
  readonly userTsconfig?: TypeScriptConfig;
  readonly stripDeprecated?: boolean;
  readonly stripDeprecatedAllowListFile?: string;
  /** Whether to write `.warnings.jsii.js` (`--add-deprecation-warnings`). */
  readonly addDeprecationWarnings?: boolean;
  readonly compressAssembly?: boolean;
  /** Treat warnings as errors when deciding whether to log the "prevented the JSII assembly" error. */
  readonly failOnWarnings?: boolean;
}

export interface BuildProjectResult {
  readonly assembly?: spec.Assembly;
  readonly typeCount: number;
  readonly emittedFiles: string[];
  readonly emitSkipped: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Derive the entrypoint .ts from the project's declared `types` entry.
 *
 * Mirrors the classic Assembler's `mainFile` computation: start from the
 * declared `types`, turn the `.d.ts`/`.js` into `.ts`, then — if an
 * out-of-source build is configured (tsc `outDir`) — re-root the path from the
 * `outDir` into the `rootDir`. This correctly handles both conventional
 * `src`->`lib` layouts and in-place (`rootDir === outDir`) layouts.
 */
function deriveEntry(projectRoot: string, projectInfo: ProjectInfo, rootDir?: string, outDir?: string): string {
  const dts: string = projectInfo.types ?? 'index.d.ts';
  let mainFile = dts.replace(/\.d\.ts(x?)$/, '.ts$1');

  if (outDir != null) {
    // strip the outDir prefix, then prepend rootDir (if any)
    const rel = path.relative(outDir, mainFile);
    mainFile = rootDir != null ? path.join(rootDir, rel) : rel;
  }
  return path.resolve(projectRoot, mainFile);
}

/**
 * Config file errors for parts of the tsconfig that jsii skips when it reads it, like
 * the classic compiler: a broken `extends` base (unreadable TS5083, circular TS18000,
 * or errors in the base file) and compiler options TypeScript rejects (unknown
 * TS5023/TS5025, wrong type TS5024, bad value TS6046, command line only TS6266).
 */
// @TODO(NEXT): TS7 reports these tsconfig errors like tsc does; jsii hides them to match TS6-based main, which never
// saw them (aws/jsii-compiler#2982, #2991, #3029). After 7.1's first release: report the program's config file
// diagnostics and drop this set, `hasSkippedConfigErrors` and `flattenTsconfig`.
const SKIPPED_CONFIG_ERRORS = new Set([5083, 18000, 5023, 5024, 5025, 6046, 6266]);

function hasSkippedConfigErrors(program: any, tsconfigPath: string): boolean {
  const errors: any[] = program.getConfigFileParsingDiagnostics?.() ?? [];
  return errors.some(
    (d) =>
      SKIPPED_CONFIG_ERRORS.has(d.code) ||
      (d.fileName != null && path.resolve(d.fileName) !== path.resolve(tsconfigPath)),
  );
}

/**
 * A tsconfig text for a configuration TypeScript's parser already resolved: its
 * options (path options are absolute; `pathsBasePath` is internal, so `paths` are
 * made absolute against it instead) and its source files.
 */
function flattenTsconfig(config: TypeScriptConfig): string {
  const { pathsBasePath, ...compilerOptions } = convertForTsconfigFile(config.compilerOptions) as any;
  if (compilerOptions.paths != null && compilerOptions.baseUrl == null && pathsBasePath != null) {
    compilerOptions.paths = Object.fromEntries(
      Object.entries(compilerOptions.paths as Record<string, string[]>).map(([k, v]) => [
        k,
        v.map((p) => path.posix.resolve(pathsBasePath, p)),
      ]),
    );
  }
  // `include` holds the parsed file names, as with the classic compiler.
  return JSON.stringify({ files: config.include ?? [], compilerOptions });
}

/** The program reports config paths as absolute paths; record them relative to the project, like the classic compiler. */
function relativeConfigPath(projectRoot: string, configPath: string | undefined): string | undefined {
  return configPath != null && path.isAbsolute(configPath) ? path.relative(projectRoot, configPath) : configPath;
}

/**
 * The diagnostic for an entry point that is not part of the program. When package.json's `types` is outside of tsc's
 * outDir, it can't be re-rooted from there, so report that (with where tsc puts the declarations) instead.
 */
function missingEntryDiagnostic(entry: string, projectInfo: ProjectInfo, rootDir?: string, outDir?: string) {
  const dts: string = projectInfo.types ?? 'index.d.ts';
  const mainFile = dts.replace(/\.d\.ts(x?)$/, '.ts$1');
  if (outDir == null || !isOutsideOfDirectory(path.relative(outDir, mainFile))) {
    return JsiiDiagnostic.JSII_0004_COULD_NOT_FIND_ENTRYPOINT.createDetached(entry);
  }
  const fromRootDir = path.relative(rootDir ?? '.', dts);
  const suggestion = isOutsideOfDirectory(fromRootDir) ? undefined : path.join(outDir, fromRootDir);
  return JsiiDiagnostic.JSII_0008_TYPES_OUTSIDE_OUT_DIR.createDetached(dts, outDir, suggestion);
}

/** Whether a path that is relative to some directory points outside of that directory. */
function isOutsideOfDirectory(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}

/**
 * Run the ts backend for a package: produce and write the `.jsii` assembly.
 */
export function buildProject(options: BuildProjectOptions): BuildProjectResult {
  const { projectRoot, projectInfo } = options;

  let host = CompilerHost.open(options.projectRoot, options.tsconfigFileName);
  let project = host.getProject();
  // The program's own diagnostics (options and config): the type check is the slow part (see `check` below).
  let tsDiagnostics = collectTsDiagnostics(project.program, CONFIG_DIAGNOSTICS);
  let tsconfigText: string | undefined;

  // The classic compiler built from the options it read itself and never saw the
  // config file errors of a broken `extends` (missing, unparseable or circular
  // base) or of options TypeScript rejects. TypeScript 7 reports those and then
  // skips the emit. Build such a project from the configuration jsii read instead,
  // which skips the broken bases and the rejected options.
  if (options.userTsconfig != null && hasSkippedConfigErrors(project.program, host.tsconfigPath)) {
    host.close();
    tsconfigText = flattenTsconfig(options.userTsconfig);
    host = CompilerHost.open(options.projectRoot, options.tsconfigFileName, tsconfigText);
    project = host.getProject();
    tsDiagnostics = collectTsDiagnostics(project.program, CONFIG_DIAGNOSTICS);
  }

  // TypeScript 7 no longer infers `rootDir` from the common directory of the
  // sources when `outDir` is set (TS5011). The classic compiler relied on that
  // inference for the output layout and recorded the inferred directory as
  // `metadata.tscRootDir`; do the same for generated configs: infer it from the
  // program's root files, write it into the tsconfig and open the project again.
  if (options.generatedTsconfig && projectInfo.tsc?.rootDir == null && tsDiagnostics.some((d) => d.code === 5011)) {
    const inferred = inferRootDir(project.rootFileNames, projectRoot);
    if (inferred != null) {
      const tsconfigPath = path.join(projectRoot, options.tsconfigFileName ?? 'tsconfig.json');
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
      tsconfig.compilerOptions = { ...tsconfig.compilerOptions, rootDir: inferred };
      fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2), 'utf8');
      host.close();
      tsconfigText = undefined;
      host = CompilerHost.open(options.projectRoot, options.tsconfigFileName);
      project = host.getProject();
      tsDiagnostics = collectTsDiagnostics(project.program, CONFIG_DIAGNOSTICS);
    }
  }

  // Like the classic compiler, take `outDir` and `rootDir` from the tsconfig the
  // program uses: as written in `package.json` for a generated tsconfig, from the
  // program's options for a user-provided one. `rootDir` only counts with an
  // `outDir`; when it is not set, use the common directory of the sources, as tsc did.
  // @TODO(NEXT): generated-config dirs stay as written in package.json (`./build`, `.`) because main records them so
  // in `metadata.tscOutDir`/`tscRootDir`; a user tsconfig gives normalized ones (`build`, ``). After 7.1's first
  // release: normalize both (changes the assembly fingerprint).
  const compilerOptions = options.generatedTsconfig
    ? { outDir: projectInfo.tsc?.outDir, rootDir: projectInfo.tsc?.rootDir }
    : {
        outDir: relativeConfigPath(projectRoot, project.program.getCompilerOptions().outDir),
        rootDir: relativeConfigPath(projectRoot, project.program.getCompilerOptions().rootDir),
      };
  const tscOutDir = compilerOptions.outDir;
  const tscRootDir =
    tscOutDir != null ? compilerOptions.rootDir ?? inferRootDir(project.rootFileNames, projectRoot) : undefined;

  const entry = deriveEntry(projectRoot, projectInfo, tscRootDir, tscOutDir);

  // @TODO(NEXT): TS5074 is a main bug (lost `configFilePath`); TS7 and tsc build this config fine
  // (aws/jsii-compiler#3025). After 7.1's first release: delete this block.
  // The classic compiler handed a user tsconfig's options to TypeScript without the
  // file they came from, so TypeScript rejected `incremental` without a
  // `tsBuildInfoFile` (TS5074, an options error that also stops the emit).
  const programOptions = project.program.getCompilerOptions();
  // (TS5074 is added to the diagnostics with the others, below.)
  const incrementalWithoutBuildInfo =
    !options.generatedTsconfig && programOptions.incremental && programOptions.tsBuildInfoFile == null;

  // The type check of the whole program and the emit are slow (TypeScript 7 does them in a process of its own, and
  // jsii only waits for it), and the assembler does not depend on them: a big project does both in a second process
  // while it assembles, and collects the results when it needs them. Without TS5074 (that one stops the emit, which
  // only this process knows).
  const check =
    !incrementalWithoutBuildInfo && project.rootFileNames.length >= MIN_FILES_FOR_BACKGROUND_CHECK
      ? BackgroundCheck.start({
          packageDir: host.ts.packageDir,
          projectRoot,
          tsconfigPath: host.tsconfigPath,
          tsconfigText,
          errorCategory: DiagnosticCategory.Error,
          categories: Object.values(DiagnosticCategory).filter((c): c is number => typeof c === 'number'),
          noEmitOnError: !!programOptions.noEmitOnError,
        })
      : undefined;

  // Like the classic compiler, log one error line for the first stage that fails:
  // TypeScript ("Compilation errors"), then the assembler ("Type model errors"),
  // then the emit ("Compilation errors"). Warnings count with `failOnWarnings`.
  let failureLogged = false;
  // @TODO(NEXT): with --fail-on-warnings, assembler warnings log "Type model errors" though there are none
  // (aws/jsii-compiler#2981). After 7.1's first release: log a warnings-specific line when no error is present.
  const logFailure = (stage: 'Compilation' | 'Type model', diagnostics: readonly Diagnostic[] | undefined) => {
    const abortable =
      diagnostics == null ||
      diagnostics.some(
        (d) =>
          d.category === DiagnosticCategory.Error ||
          (options.failOnWarnings && d.category === DiagnosticCategory.Warning && !isSilenced(d)),
      );
    if (!failureLogged && abortable) {
      failureLogged = true;
      LOG.error(`${stage} errors prevented the JSII assembly from being created`);
    }
  };

  let tsHasErrors = false;
  let checkedEmit: BackgroundCheckResult['emit'];
  let settled = false;
  const diagnostics: Diagnostic[] = [];
  /** Take the type check's results (from the second process when there is one) and report them first. */
  const settleTsDiagnostics = () => {
    if (settled) {
      return;
    }
    settled = true;
    const checked = check?.wait();
    tsDiagnostics = checked != null ? toDiagnostics(checked.diagnostics) : collectTsDiagnostics(project.program);
    checkedEmit = checked?.emit;
    if (incrementalWithoutBuildInfo) {
      tsDiagnostics = [
        ...tsDiagnostics,
        {
          ...syntheticErrorDiagnostic(
            "Option '--incremental' can only be specified using tsconfig, emitting to single file or when option '--tsBuildInfoFile' is specified.",
          ),
          code: 5074,
        },
      ];
    }
    logFailure('Compilation', tsDiagnostics);
    tsHasErrors = tsDiagnostics.some((d) => d.category === DiagnosticCategory.Error);
    diagnostics.push(...tsDiagnostics);
  };

  try {
    if (check == null) {
      settleTsDiagnostics();
    }

    // Like the classic compiler, assemble and emit even when an earlier stage
    // failed, so all diagnostics are reported together. The `.jsii` file is
    // written when the assembler reports no errors, whatever TypeScript reported.
    let assembly: spec.Assembly | undefined;
    let jsiiFailed = true;
    let deprecationWarnings: DeprecationWarningsInjector | undefined;
    let strippedClasses: readonly spec.ClassType[] | undefined;
    let declarationsStripping: DeclarationsStripping | undefined;
    if (!project.program.getSourceFile(entry)) {
      settleTsDiagnostics();
      logFailure('Type model', undefined);
      diagnostics.push(missingEntryDiagnostic(entry, projectInfo, tscRootDir, tscOutDir));
    } else {
      const assembler = new Assembler(host.ts, project, {
        packageJson: projectInfo.packageJson,
        projectInfo,
        projectRoot,
        entry,
        assemblyName: projectInfo.name,
        defaultStability: projectInfo.stability,
        stripDeprecated: options.stripDeprecated ?? !!(projectInfo.packageJson as any)['cdk-build']?.stripDeprecated,
        stripDeprecatedAllowListFile: options.stripDeprecatedAllowListFile,
        tscRootDir,
        tscOutDir,
        readme: loadReadme(projectRoot),
      });

      let assembled: spec.Assembly | undefined;
      let assembleError: unknown;
      try {
        assembled = assembler.assemble();
      } catch (e: any) {
        assembleError = e;
      }
      // TypeScript's diagnostics come before the assembler's.
      settleTsDiagnostics();

      try {
        if (assembled == null) {
          throw assembleError;
        }
        assembly = assembled;
        strippedClasses = assembler.strippedClasses;
        declarationsStripping = assembler.declarationsStripping;
        const jsiiDiagnostics = assembler.diagnostics;

        // Classic: the deprecation warnings are made when the type model has no errors, even when a use of a
        // stripped type (JSII3999) or a validator reports one.
        if (!assembler.typeModelFailed && options.addDeprecationWarnings) {
          assembly.metadata = {
            ...assembly.metadata,
            jsii: { ...(assembly.metadata?.jsii ?? {}), compiledWithDeprecationWarnings: true },
          };
          deprecationWarnings = new DeprecationWarningsInjector(host.ts, project, assembler.enumMemberDeclarations);
          deprecationWarnings.process(assembly, projectInfo);
        }
        diagnostics.push(...jsiiDiagnostics);
        logFailure('Type model', jsiiDiagnostics);
        jsiiFailed = jsiiDiagnostics.some((d) => d.category === DiagnosticCategory.Error);
      } catch (e: any) {
        // Same contract as the classic compiler: a failure while assembling is
        // reported as a JSII9997 error diagnostic rather than crashing the build.
        // @TODO(NEXT): a failure of the deprecation warnings (a property of a stripped type) loses the other
        // diagnostics, as in the classic compiler (aws/jsii-compiler#3013). After 7.1's first release: report them.
        diagnostics.push(
          ...(assembled ? [] : assembler.diagnostics),
          JsiiDiagnostic.JSII_9997_UNKNOWN_ERROR.createDetached(e),
        );
        // shortcut: the classic compiler emitted what the warnings had made before the failure; this emits none.
        deprecationWarnings = undefined;
      }

      if (process.env.JSII_TS7_TIMING) {
        LOG.info(`ts doc-cache hits (RPCs avoided): ${assembler.docCacheHits}`);
      }
    }

    // Write the assembly first (the parity artifact), reusing @jsii/spec's writer
    // so the on-disk format (incl. the compressed file-redirect variant) matches
    // the strada path exactly.
    // @TODO(NEXT): `.jsii` is written even when TypeScript reported errors, while the log says "Compilation errors
    // prevented the JSII assembly from being created" (aws/jsii-compiler#2980). After 7.1's first release: also
    // require `!tsHasErrors`.
    if (assembly != null && !jsiiFailed) {
      writeAssembly(projectRoot, fingerprint(assembly), { compress: options.compressAssembly ?? false });
    }

    // Then emit JS/d.ts and inject jsii rtti (post-emit pass). Like the classic
    // compiler, the emit runs even after jsii errors. An emit failure fails the
    // build (emitSkipped + a synthetic diagnostic); the assembly file is left on
    // disk to aid debugging, but the exit status reflects the error.
    let emittedFiles: string[] = [];
    let emitDiagnostics: readonly any[] = [];
    let emitFailed = false;
    try {
      if (tsHasErrors && programOptions.noEmitOnError) {
        // Errors TypeScript 7 does not know about (above) must stop the emit too.
        throw new Error('TypeScript emit was skipped');
      }
      ({ emittedFiles, diagnostics: emitDiagnostics } = emitProject(host.ts, project, {
        projectRoot,
        assembly: assembly ?? ({ version: projectInfo.version, types: {} } as unknown as spec.Assembly),
        outDir: tscOutDir,
        rootDir: tscRootDir,
        deprecationWarnings,
        strippedClasses,
        emitResult: checkedEmit,
        declarationsStripping,
      }));
    } catch (err) {
      if (err instanceof MergedDeclarationError) {
        // @TODO(NEXT): the classic compiler failed with this error (aws/jsii-compiler#3012). After 7.1's first
        // release: do not fail (see MergedDeclarationError).
        throw err;
      }
      emitFailed = true;
      // With TypeScript errors, `noEmitOnError` skips the emit; those errors are already reported.
      // shortcut: any emit failure is silent then, even without `noEmitOnError`; tell them apart if one shows up.
      if (!tsHasErrors) {
        LOG.error(`ts backend: emit pipeline failed: ${(err as Error).stack ?? (err as Error).message}`);
        logFailure('Compilation', undefined);
        diagnostics.push(syntheticErrorDiagnostic(`ts backend: emit pipeline failed: ${(err as Error).message}`));
      }
    }

    // Like the classic compiler, the diagnostics of the emit itself (TS5033 when an output file cannot be written)
    // are reported, and an error among them fails the build.
    const emitted = emitDiagnostics.map((d) => toDiagnostic(d, readSourceFile));
    logFailure('Compilation', emitted);
    diagnostics.push(...emitted);

    const failed = emitFailed || diagnostics.some((d) => d.category === DiagnosticCategory.Error);
    return {
      assembly: jsiiFailed ? undefined : assembly,
      typeCount: failed ? 0 : Object.keys(assembly?.types ?? {}).length,
      emittedFiles: failed ? [] : emittedFiles,
      emitSkipped: failed,
      diagnostics,
    };
  } finally {
    if (process.env.JSII_TS7_TIMING) {
      const t = host.getTimingInfo?.();
      if (t?.totals) {
        LOG.info(
          `ts timing: requests=${t.totals.requestCount} roundTripMs=${Math.round(t.totals.roundTripMs)} ` +
            `serverTimeMs=${Math.round(t.totals.serverTimeMs ?? 0)} transportOverheadMs=${Math.round(
              t.totals.transportOverheadMs ?? 0,
            )} ` +
            `sent=${t.totals.bytesSent} recv=${t.totals.bytesReceived}`,
        );
      }
    }
    check?.wait();
    host.close();
  }
}

/** The text of a file a diagnostic points into, if it can be read. */
function readSourceFile(fileName: string): string | undefined {
  try {
    return fs.readFileSync(fileName, 'utf8');
  } catch {
    return undefined;
  }
}

/** Like tsc: errors of the tsconfig file come first. Without them, an error TypeScript reports only there (such as TS18002) just skips the emit, as "TS0: emit pipeline failed". */
const CONFIG_DIAGNOSTICS = ['getConfigFileParsingDiagnostics', 'getProgramDiagnostics'];
const ALL_DIAGNOSTICS = [
  ...CONFIG_DIAGNOSTICS,
  'getGlobalDiagnostics',
  'getSyntacticDiagnostics',
  'getSemanticDiagnostics',
];

/**
 * Collect the program's pre-emit diagnostics (options, global, syntactic and
 * semantic) from the program and map them to jsii's `Diagnostic` for the
 * standard reporting pipeline.
 */
function collectTsDiagnostics(program: any, names = ALL_DIAGNOSTICS): Diagnostic[] {
  const call = (name: string): any[] => (typeof program[name] === 'function' ? program[name]() ?? [] : []);
  return toDiagnostics(names.flatMap(call));
}

/** The diagnostics of the API as jsii's, with the text of the files they point into. */
function toDiagnostics(raw: readonly any[]): Diagnostic[] {
  const texts = new Map<string, string | undefined>();
  const readSource = (fileName: string): string | undefined => {
    if (!texts.has(fileName)) {
      try {
        texts.set(fileName, fs.readFileSync(fileName, 'utf8'));
      } catch {
        texts.set(fileName, undefined);
      }
    }
    return texts.get(fileName);
  };
  return raw.map((d) => toDiagnostic(d, readSource));
}

/**
 * Map one TypeScript 7 API diagnostic (`{ fileName, pos, end, code, category, text }`)
 * to jsii's `Diagnostic`. The file text is attached so the formatter renders the
 * same `file:line:col - error TSxxxx:` layout, with source context, that the
 * classic compiler produced. Exported for unit tests.
 */
export function toDiagnostic(d: any, readSource: (fileName: string) => string | undefined): Diagnostic {
  const category = Object.values(DiagnosticCategory).includes(d.category)
    ? (d.category as DiagnosticCategory)
    : DiagnosticCategory.Error;
  const fileName: string | undefined = typeof d.fileName === 'string' ? d.fileName : undefined;
  const file = fileName != null ? { fileName, text: readSource(fileName) } : undefined;
  const hasRange = file != null && typeof d.pos === 'number' && typeof d.end === 'number' && d.end >= d.pos;
  return {
    category,
    code: typeof d.code === 'number' ? d.code : 0,
    file,
    start: hasRange ? d.pos : undefined,
    length: hasRange ? d.end - d.pos : undefined,
    messageText: typeof d.text === 'string' ? d.text : d.messageText ?? d.message ?? String(d),
  };
}

/** Compare like TypeScript's `compareDiagnostics`: file name, start, length, code, message. */
function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    compareValues(a.file?.fileName, b.file?.fileName) ||
    compareValues(a.start, b.start) ||
    compareValues(a.length, b.length) ||
    compareValues(a.code, b.code) ||
    compareValues(flattenDiagnosticMessageText(a.messageText), flattenDiagnosticMessageText(b.messageText))
  );
}

/** Ordinal comparison; `undefined` sorts first. */
function compareValues<T extends string | number>(a: T | undefined, b: T | undefined): number {
  if (a === b) {
    return 0;
  }
  if (a === undefined) {
    return -1;
  }
  if (b === undefined) {
    return 1;
  }
  return a < b ? -1 : 1;
}

/**
 * Port of `ts.sortAndDeduplicateDiagnostics` (stable sort, then drop adjacent
 * duplicates, keeping the first). The category is not part of the comparison.
 * shortcut: no related information, and message chains are compared by their
 * flattened text; upgrade if jsii starts producing chains.
 */
export function sortAndDeduplicateDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const sorted = [...diagnostics].sort(compareDiagnostics);
  return sorted.filter((d, i) => i === 0 || compareDiagnostics(sorted[i - 1], d) !== 0);
}

/** An error diagnostic with no source location. */
function syntheticErrorDiagnostic(messageText: string): Diagnostic {
  return {
    category: DiagnosticCategory.Error,
    code: 0,
    file: undefined,
    start: undefined,
    length: undefined,
    messageText,
  };
}

/**
 * Load and render the package README the same way the default backend does
 * (including literate example inclusion), so `assembly.readme` matches.
 */
function loadReadme(projectRoot: string): spec.ReadMe | undefined {
  const fileName = fs.readdirSync(projectRoot).find((file) => file.toLocaleLowerCase() === 'readme.md');
  if (fileName == null) {
    return undefined;
  }
  const readmePath = path.join(projectRoot, fileName);
  return {
    markdown: literate
      .includeAndRenderExamples(literate.loadFromFile(readmePath), literate.fileSystemLoader(projectRoot), projectRoot)
      .join('\n'),
  };
}

/**
 * Port of the classic `inferRootDir`: the longest directory (relative to the
 * project root) shared by all root files of the configuration, or `undefined`
 * when they only share the project root itself.
 */
function inferRootDir(rootFileNames: readonly string[], projectRoot: string): string | undefined {
  const directories = rootFileNames
    .filter((fileName) => !fileName.split(path.sep).includes('node_modules'))
    .map((fileName) => path.relative(projectRoot, path.dirname(fileName)))
    .map(segmentPath);
  if (directories.length === 0) {
    return undefined;
  }
  const maxPrefix = Math.min(...directories.map((segments) => segments.length - 1));
  let commonIndex = -1;
  while (commonIndex < maxPrefix && new Set(directories.map((segments) => segments[commonIndex + 1])).size === 1) {
    commonIndex++;
  }
  if (commonIndex < 0) {
    return undefined;
  }
  return directories[0][commonIndex];

  function segmentPath(fileName: string): string[] {
    const result = new Array<string>();
    for (let parent = fileName; parent !== path.dirname(parent); parent = path.dirname(parent)) {
      result.unshift(parent);
    }
    return result;
  }
}

/** Mirror of strada `_fingerprint`: sort keys, hash, stamp `fingerprint`. */
function fingerprint(assembly: spec.Assembly): spec.Assembly {
  delete (assembly as any).fingerprint;
  const sorted = sortJson(assembly);
  const hash = crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('base64');
  return { ...sorted, fingerprint: hash };
}
