import * as fs from 'node:fs';
import * as path from 'node:path';
import * as chalk from 'chalk';
import * as log4js from 'log4js';
import * as ts from 'typescript';

import { Assembler } from './assembler';
import { findDependencyDirectory } from './common/find-utils';
import { emitDownleveledDeclarations, TYPES_COMPAT } from './downlevel-dts';
import { Emitter } from './emitter';
import { normalizeConfigPath } from './helpers';
import { JsiiDiagnostic } from './jsii-diagnostic';
import { ProjectInfo } from './project-info';
import { WARNINGSCODE_FILE_NAME } from './transforms/deprecation-warnings';
import { TypeScriptConfig, TypeScriptConfigValidationRuleSet } from './tsconfig';
import { BASE_COMPILER_OPTIONS, convertForJson } from './tsconfig/compiler-options';
import { TypeScriptConfigValidator } from './tsconfig/tsconfig-validator';
import { ValidationError } from './tsconfig/validator';
import * as utils from './utils';

const LOG = log4js.getLogger('jsii/compiler');
export const DIAGNOSTICS = 'diagnostics';
export const JSII_DIAGNOSTICS_CODE = 9999;

export interface CompilerOptions {
  /** The information about the project to be built */
  projectInfo: ProjectInfo;
  /** Whether the compiler should watch for changes or just compile once */
  watch?: boolean;
  /** Whether to detect and generate TypeScript project references */
  projectReferences?: boolean;
  /** Whether to fail when a warning is emitted */
  failOnWarnings?: boolean;
  /** Whether to strip deprecated members from emitted artifacts */
  stripDeprecated?: boolean;
  /** The path to an allowlist of FQNs to strip if stripDeprecated is set */
  stripDeprecatedAllowListFile?: string;
  /** Whether to add warnings for deprecated elements */
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

export class Compiler implements Emitter {
  private readonly system: ts.System;
  private readonly compilerHost: ts.CompilerHost;
  private readonly userProvidedTypeScriptConfig: boolean;
  private readonly tsconfig: TypeScriptConfig;
  private rootFiles: string[] = [];
  private readonly configPath: string;
  private readonly projectRoot: string;

  public constructor(private readonly options: CompilerOptions) {
    if (options.generateTypeScriptConfig != null && options.typeScriptConfig != null) {
      throw new Error(
        'Cannot use `generateTypeScriptConfig` and `typeScriptConfig` together. Provide only one of them.',
      );
    }

    this.projectRoot = this.options.projectInfo.projectRoot;
    const configFileName = options.typeScriptConfig ?? options.generateTypeScriptConfig ?? 'tsconfig.json';
    this.configPath = path.join(this.projectRoot, configFileName);
    this.userProvidedTypeScriptConfig = Boolean(options.typeScriptConfig);

    this.system = {
      ...ts.sys,
      getCurrentDirectory: () => this.projectRoot,
      createDirectory: (pth) => ts.sys.createDirectory(path.resolve(this.projectRoot, pth)),
      deleteFile: ts.sys.deleteFile && ((pth) => ts.sys.deleteFile!(path.join(this.projectRoot, pth))),
      fileExists: (pth) => ts.sys.fileExists(path.resolve(this.projectRoot, pth)),
      getFileSize: ts.sys.getFileSize && ((pth) => ts.sys.getFileSize!(path.resolve(this.projectRoot, pth))),
      readFile: (pth, encoding) => ts.sys.readFile(path.resolve(this.projectRoot, pth), encoding),
      watchFile:
        ts.sys.watchFile &&
        ((pth, callback, pollingInterval, watchOptions) =>
          ts.sys.watchFile!(path.resolve(this.projectRoot, pth), callback, pollingInterval, watchOptions)),
      writeFile: (pth, data, writeByteOrderMark) =>
        ts.sys.writeFile(path.resolve(this.projectRoot, pth), data, writeByteOrderMark),
    };

    this.tsconfig = this.configureTypeScript();
    this.compilerHost = ts.createIncrementalCompilerHost(this.tsconfig.compilerOptions, this.system);
  }

  /**
   * Compiles the configured program.
   *
   * @param files can be specified to override the standard source code location logic. Useful for example when testing "negatives".
   */
  public emit(...files: string[]): ts.EmitResult {
    this.prepareForBuild(...files);
    return this.buildOnce();
  }

  /**
   * Watches for file-system changes and dynamically recompiles the project as needed. In non-blocking mode, this
   * returns the TypeScript watch handle for the application to use.
   *
   * @internal
   */
  public async watch(opts: NonBlockingWatchOptions): Promise<ts.Watch<ts.BuilderProgram>>;
  /**
   * Watches for file-system changes and dynamically recompiles the project as needed. In blocking mode, this results
   * in a never-resolving promise.
   */
  public async watch(): Promise<never>;
  public async watch(opts?: NonBlockingWatchOptions): Promise<ts.Watch<ts.BuilderProgram> | never> {
    this.prepareForBuild();

    const host = ts.createWatchCompilerHost(
      this.configPath,
      {
        ...this.tsconfig.compilerOptions,
        noEmitOnError: false,
      },
      this.system,
      ts.createEmitAndSemanticDiagnosticsBuilderProgram,
      opts?.reportDiagnostics,
      opts?.reportWatchStatus,
      this.tsconfig.watchOptions,
    );
    if (!host.getDefaultLibLocation) {
      throw new Error('No default library location was found on the TypeScript compiler host!');
    }
    const orig = host.afterProgramCreate;
    // This is a callback cascade, so it's "okay" to return an unhandled promise there. This may
    // cause an unhandled promise rejection warning, but that's not a big deal.
    //
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    host.afterProgramCreate = (builderProgram) => {
      const emitResult = this.consumeProgram(builderProgram.getProgram(), host.getDefaultLibLocation!());

      for (const diag of emitResult.diagnostics.filter((d) => d.code === JSII_DIAGNOSTICS_CODE)) {
        utils.logDiagnostic(diag, this.projectRoot);
      }

      if (orig) {
        orig.call(host, builderProgram);
      }
      if (opts?.compilationComplete) {
        opts.compilationComplete(emitResult);
      }
    };
    const watch = ts.createWatchProgram(host);

    if (opts?.nonBlocking) {
      // In non-blocking mode, returns the handle to the TypeScript watch interface.
      return watch;
    }
    // In blocking mode, returns a never-resolving promise.
    return new Promise<never>(() => null);
  }

  /**
   * Prepares the project for build, by creating the necessary configuration
   * file(s), and assigning the relevant root file(s).
   *
   * @param files the files that were specified as input in the CLI invocation.
   */
  private configureTypeScript(): TypeScriptConfig {
    if (this.userProvidedTypeScriptConfig) {
      const config = this.readTypeScriptConfig();

      // emit a warning if validation is disabled
      const rules = this.options.validateTypeScriptConfig ?? TypeScriptConfigValidationRuleSet.NONE;
      if (rules === TypeScriptConfigValidationRuleSet.NONE) {
        utils.logDiagnostic(
          JsiiDiagnostic.JSII_4009_DISABLED_TSCONFIG_VALIDATION.create(undefined, this.configPath),
          this.projectRoot,
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

          throw new Error(
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
   * Final preparations of the project for build.
   *
   * These are preparations that either
   * - must happen immediately before the build, or
   * - can be different for every build like assigning the relevant root file(s).
   *
   * @param files the files that were specified as input in the CLI invocation.
   */
  private prepareForBuild(...files: string[]) {
    if (!this.userProvidedTypeScriptConfig) {
      this.writeTypeScriptConfig();
    }

    this.rootFiles = this.determineSources(files);
  }

  /**
   * Do a single build
   */
  private buildOnce(): ts.EmitResult {
    if (!this.compilerHost.getDefaultLibLocation) {
      throw new Error('No default library location was found on the TypeScript compiler host!');
    }

    const tsconf = this.tsconfig!;

    const prog = ts.createIncrementalProgram({
      rootNames: this.rootFiles.concat(_pathOfLibraries(this.compilerHost)),
      options: tsconf.compilerOptions,
      // Make the references absolute for the compiler
      projectReferences: tsconf.references?.map((ref) => ({
        path: path.resolve(path.dirname(this.configPath), ref.path),
      })),
      host: this.compilerHost,
    });

    return this.consumeProgram(prog.getProgram(), this.compilerHost.getDefaultLibLocation());
  }

  private consumeProgram(program: ts.Program, stdlib: string): ts.EmitResult {
    const diagnostics = [...ts.getPreEmitDiagnostics(program)];
    let hasErrors = false;

    if (!hasErrors && this.diagsHaveAbortableErrors(diagnostics)) {
      hasErrors = true;
      LOG.error('Compilation errors prevented the JSII assembly from being created');
    }

    // Do the "Assembler" part first because we need some of the analysis done in there
    // to post-process the AST
    const assembler = new Assembler(this.options.projectInfo, this.system, program, stdlib, {
      stripDeprecated: this.options.stripDeprecated,
      stripDeprecatedAllowListFile: this.options.stripDeprecatedAllowListFile,
      addDeprecationWarnings: this.options.addDeprecationWarnings,
      compressAssembly: this.options.compressAssembly,
    });

    try {
      const assmEmit = assembler.emit();
      if (!hasErrors && (assmEmit.emitSkipped || this.diagsHaveAbortableErrors(assmEmit.diagnostics))) {
        hasErrors = true;
        LOG.error('Type model errors prevented the JSII assembly from being created');
      }

      diagnostics.push(...assmEmit.diagnostics);
    } catch (e: any) {
      diagnostics.push(JsiiDiagnostic.JSII_9997_UNKNOWN_ERROR.createDetached(e));
      hasErrors = true;
    }

    // Do the emit, but add in transformers which are going to replace real
    // comments with synthetic ones.
    const emit = program.emit(
      undefined, // targetSourceFile
      undefined, // writeFile
      undefined, // cancellationToken
      undefined, // emitOnlyDtsFiles
      assembler.customTransformers,
    );
    diagnostics.push(...emit.diagnostics);

    if (!hasErrors && (emit.emitSkipped || this.diagsHaveAbortableErrors(emit.diagnostics))) {
      hasErrors = true;
      LOG.error('Compilation errors prevented the JSII assembly from being created');
    }

    if (!hasErrors) {
      emitDownleveledDeclarations(
        this.projectRoot,
        this.options.projectInfo.packageJson,
        // outDir might be absolute. Need to normalize it.
        normalizeConfigPath(this.projectRoot, this.tsconfig.compilerOptions.outDir),
      );
    }

    // Some extra validation on the config.
    // Make sure that { "./.warnings.jsii.js": "./.warnings.jsii.js" } is in the set of
    // exports, if they are specified.
    if (this.options.addDeprecationWarnings && this.options.projectInfo.exports !== undefined) {
      const expected = `./${WARNINGSCODE_FILE_NAME}`;
      const warningsExport = Object.entries(this.options.projectInfo.exports).filter(
        ([k, v]) => k === expected && v === expected,
      );

      if (warningsExport.length === 0) {
        hasErrors = true;
        diagnostics.push(JsiiDiagnostic.JSII_0007_MISSING_WARNINGS_EXPORT.createDetached());
      }
    }

    return {
      emitSkipped: hasErrors,
      diagnostics: ts.sortAndDeduplicateDiagnostics(diagnostics),
      emittedFiles: emit.emittedFiles,
    };
  }

  /**
   * Build the TypeScript config object from jsii config
   *
   * This is the object that will be written to disk
   * unless an existing tsconfig was provided.
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
    const configDir = path.dirname(this.configPath);
    const absoluteTypesCompat = path.resolve(configDir, pi.tsc?.outDir ?? '.', TYPES_COMPAT);
    const relativeTypesCompat = path.relative(configDir, absoluteTypesCompat);

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
        relativeTypesCompat,
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
   * Load the TypeScript config object from a provided file
   */
  private readTypeScriptConfig(): TypeScriptConfig {
    const projectRoot = this.options.projectInfo.projectRoot;
    const { config, error } = ts.readConfigFile(this.configPath, ts.sys.readFile);
    if (error) {
      utils.logDiagnostic(error, projectRoot);
      throw new Error(`Failed to load tsconfig at ${this.configPath}`);
    }
    const extended = ts.parseJsonConfigFileContent(config, ts.sys, projectRoot);
    // the tsconfig parser adds this in, but it is not an expected compilerOption
    delete extended.options.configFilePath;

    return {
      compilerOptions: extended.options,
      watchOptions: extended.watchOptions,
      include: extended.fileNames,
    };
  }

  /**
   * Creates a `tsconfig.json` file to improve the IDE experience.
   *
   * @return the fully qualified path to the `tsconfig.json` file
   */
  private writeTypeScriptConfig(): void {
    const commentKey = '_generated_by_jsii_';
    const commentValue = 'Generated by jsii - safe to delete, and ideally should be in .gitignore';

    (this.tsconfig as any)[commentKey] = commentValue;

    if (fs.existsSync(this.configPath)) {
      const currentConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      if (!(commentKey in currentConfig)) {
        throw new Error(
          `A '${this.configPath}' file that was not generated by jsii is in ${this.options.projectInfo.projectRoot}. Aborting instead of overwriting.`,
        );
      }
    }

    const outputConfig = {
      ...this.tsconfig,
      compilerOptions: convertForJson(this.tsconfig?.compilerOptions),
    };

    LOG.debug(`Creating or updating ${chalk.blue(this.configPath)}`);
    fs.writeFileSync(this.configPath, JSON.stringify(outputConfig, null, 2), 'utf8');
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

      const { config: tsconfig } = ts.readConfigFile(tsconfigFile, this.system.readFile);

      // Add references to any TypeScript package we find that is 'composite' enabled.
      // Make it relative.
      if (tsconfig.compilerOptions?.composite) {
        ret.push(path.relative(this.options.projectInfo.projectRoot, path.dirname(tsconfigFile)));
      } else {
        // Not a composite package--if this package is in a node_modules directory, that is most
        // likely correct, otherwise it is most likely an error (heuristic here, I don't know how to
        // properly check this).
        if (tsconfigFile.includes('node_modules')) {
          LOG.warn('%s: not a composite TypeScript package, but it probably should be', path.dirname(tsconfigFile));
        }
      }
    }

    return ret;
  }

  /**
   * Find source files using the same mechanism that the TypeScript compiler itself uses.
   *
   * Respects includes/excludes/etc.
   *
   * This makes it so that running 'typescript' and running 'jsii' has the same behavior.
   */
  private determineSources(files: string[]): string[] {
    // explicitly requested files
    if (files.length > 0) {
      return [...files];
    }

    // for user provided config we already have parsed the full list of files
    if (this.userProvidedTypeScriptConfig) {
      return [...(this.tsconfig.include ?? [])];
    }

    // finally get the file list for the generated config
    const parseConfigHost = parseConfigHostFromCompilerHost(this.compilerHost);
    const parsed = ts.parseJsonConfigFileContent(this.tsconfig, parseConfigHost, this.options.projectInfo.projectRoot);
    return [...parsed.fileNames];
  }

  /**
   * Resolve the given dependency name from the current package, and find the associated tsconfig.json location
   *
   * Because we have the following potential directory layout:
   *
   *   package/node_modules/some_dependency
   *   package/tsconfig.json
   *
   * We resolve symlinks and only find a "TypeScript" dependency if doesn't have 'node_modules' in
   * the path after resolving symlinks (i.e., if it's a peer package in the same monorepo).
   *
   * Returns undefined if no such tsconfig could be found.
   */
  private findMonorepoPeerTsconfig(depName: string): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-require-imports,@typescript-eslint/no-var-requires
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

      // Resolve symlinks, to check if this is a monorepo peer
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

  private diagsHaveAbortableErrors(diags: readonly ts.Diagnostic[]) {
    return diags.some(
      (d) =>
        d.category === ts.DiagnosticCategory.Error ||
        (this.options.failOnWarnings && d.category === ts.DiagnosticCategory.Warning),
    );
  }
}

/**
 * Options for Watch in non-blocking mode.
 *
 * @internal
 */
export interface NonBlockingWatchOptions {
  /**
   * Signals non-blocking execution
   */
  readonly nonBlocking: true;

  /**
   * Configures the diagnostics reporter
   */
  readonly reportDiagnostics: ts.DiagnosticReporter;

  /**
   * Configures the watch status reporter
   */
  readonly reportWatchStatus: ts.WatchStatusReporter;

  /**
   * This hook gets invoked when a compilation cycle (complete with Assembler execution) completes.
   */
  readonly compilationComplete: (emitResult: ts.EmitResult) => void;
}

function _pathOfLibraries(host: ts.CompilerHost | ts.WatchCompilerHost<any>): string[] {
  if (!BASE_COMPILER_OPTIONS.lib || BASE_COMPILER_OPTIONS.lib.length === 0) {
    return [];
  }
  const lib = host.getDefaultLibLocation?.();
  if (!lib) {
    throw new Error(
      `Compiler host doesn't have a default library directory available for ${BASE_COMPILER_OPTIONS.lib.join(', ')}`,
    );
  }
  return BASE_COMPILER_OPTIONS.lib.map((name) => path.join(lib, name));
}

function parseConfigHostFromCompilerHost(host: ts.CompilerHost): ts.ParseConfigHost {
  // Copied from upstream
  // https://github.com/Microsoft/TypeScript/blob/9e05abcfd3f8bb3d6775144ede807daceab2e321/src/compiler/program.ts#L3105
  return {
    fileExists: (f) => host.fileExists(f),
    readDirectory(root, extensions, excludes, includes, depth) {
      if (host.readDirectory === undefined) {
        throw new Error("'CompilerHost.readDirectory' must be implemented to correctly process 'projectReferences'");
      }
      return host.readDirectory(root, extensions, excludes, includes, depth);
    },
    readFile: (f) => host.readFile(f),
    useCaseSensitiveFileNames: host.useCaseSensitiveFileNames(),
    trace: host.trace ? (s) => host.trace!(s) : undefined,
  };
}
