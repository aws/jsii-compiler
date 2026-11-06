import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import * as log4js from 'log4js';

import { findDependencyDirectory } from './common/find-utils';
import { Diagnostic } from './diagnostic';
import { JsiiDiagnostic } from './jsii-diagnostic';
import { ProjectInfo } from './project-info';
import { ts7Emit } from './ts7';
import { TypeScriptConfig, TypeScriptConfigValidationRuleSet } from './tsconfig';
import { BASE_COMPILER_OPTIONS } from './tsconfig/compiler-options';
import { parseTsconfigJson, readTypeScriptConfigFile } from './tsconfig/read';
import { TypeScriptConfigValidator } from './tsconfig/tsconfig-validator';
import { ValidationError } from './tsconfig/validator';
import * as utils from './utils';

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
   * Not implemented on the TypeScript 7 backend yet; requesting it fails with
   * an explicit error instead of silently producing an assembly without the
   * `.warnings.jsii.js` module.
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
 * type analysis, assembly generation and emit to `ts7Emit`, which drives the
 * out-of-process TypeScript 7 compiler.
 */
export class Compiler {
  private readonly userProvidedTypeScriptConfig: boolean;
  private readonly tsconfig: TypeScriptConfig;
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
    if (this.options.addDeprecationWarnings) {
      throw new utils.JsiiError('--add-deprecation-warnings is not supported by the TypeScript 7 based compiler yet');
    }
    if (files.length > 0 && this.userProvidedTypeScriptConfig) {
      throw new utils.JsiiError('Explicit source files cannot be combined with a user-provided tsconfig');
    }
    if (!this.userProvidedTypeScriptConfig) {
      this.writeTypeScriptConfig(files);
    }

    const result = ts7Emit({
      projectRoot: this.projectRoot,
      projectInfo: this.options.projectInfo,
      tsconfigFileName: this.configFileName,
      generatedTsconfig: !this.userProvidedTypeScriptConfig,
      stripDeprecated: this.options.stripDeprecated,
      stripDeprecatedAllowListFile: this.options.stripDeprecatedAllowListFile,
      compressAssembly: this.options.compressAssembly,
    });

    if (!result.emitSkipped) {
      LOG.info(`assembled ${result.typeCount} types, emitted ${result.emittedFiles.length} files`);
    }

    const hasWarnings = result.diagnostics.some((d) => d.category === 0 /* Warning */);
    return {
      emitSkipped: result.emitSkipped || (this.options.failOnWarnings === true && hasWarnings),
      diagnostics: result.diagnostics,
      emittedFiles: result.emittedFiles,
    };
  }

  private configureTypeScript(): TypeScriptConfig {
    if (this.userProvidedTypeScriptConfig) {
      const config = readTypeScriptConfigFile(this.configPath);

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
          validator.validate(config);
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
        ? { ...this.tsconfig, files: files.map((f) => path.relative(this.projectRoot, path.resolve(this.projectRoot, f))), include: undefined }
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
