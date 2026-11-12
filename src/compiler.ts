import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as spec from '@jsii/spec';
import { writeAssembly } from '@jsii/spec';
import chalk from 'chalk';
import * as log4js from 'log4js';

import { Assembler } from './assembler';
import { findDependencyDirectory } from './common/find-utils';
import { CompilerHost } from './compiler-host';
import { Diagnostic, DiagnosticCategory } from './diagnostic';
import { emitProject } from './emitter';
import { JsiiDiagnostic } from './jsii-diagnostic';
import * as literate from './literate';
import { ProjectInfo } from './project-info';
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
 * type analysis, assembly generation and emit to `buildProject`, which drives the
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

    const result = buildProject({
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

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const sortJson = require('sort-json');

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
  readonly stripDeprecated?: boolean;
  readonly stripDeprecatedAllowListFile?: string;
  readonly compressAssembly?: boolean;
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
  let mainFile = dts.replace(/\.d\.ts(x?)$/, '.ts$1').replace(/\.js$/, '.ts');

  if (outDir != null) {
    // strip the outDir prefix, then prepend rootDir (if any)
    const rel = path.relative(outDir, mainFile);
    mainFile = rootDir != null ? path.join(rootDir, rel) : rel;
  }
  return path.resolve(projectRoot, mainFile);
}

/**
 * Run the ts backend for a package: produce and write the `.jsii` assembly.
 */
export function buildProject(options: BuildProjectOptions): BuildProjectResult {
  const { projectRoot, projectInfo } = options;

  let host = CompilerHost.open(options.projectRoot, options.tsconfigFileName);
  let project = host.getProject();
  let tsDiagnostics = collectTsDiagnostics(project.program);
  let tscRootDir = projectInfo.tsc?.rootDir;
  const tscOutDir = projectInfo.tsc?.outDir;

  // TypeScript 7 no longer infers `rootDir` from the common directory of the
  // sources when `outDir` is set (TS5011). The classic compiler relied on that
  // inference for the output layout and recorded the inferred directory as
  // `metadata.tscRootDir`; do the same for generated configs: infer it from the
  // program's root files, write it into the tsconfig and open the project again.
  if (options.generatedTsconfig && tscRootDir == null && tsDiagnostics.some((d) => d.code === 5011)) {
    const inferred = inferRootDir(project.rootFileNames, projectRoot);
    if (inferred != null) {
      const tsconfigPath = path.join(projectRoot, options.tsconfigFileName ?? 'tsconfig.json');
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
      tsconfig.compilerOptions = { ...tsconfig.compilerOptions, rootDir: inferred };
      fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2), 'utf8');
      host.close();
      host = CompilerHost.open(options.projectRoot, options.tsconfigFileName);
      project = host.getProject();
      tsDiagnostics = collectTsDiagnostics(project.program);
      tscRootDir = inferred;
    }
  }

  const entry = deriveEntry(projectRoot, projectInfo, tscRootDir, tscOutDir);

  try {
    // Surface TypeScript compilation errors BEFORE assembling, with the same
    // reject-on-error behaviour as the default backend: a program that does not
    // compile must not produce an assembly.
    if (tsDiagnostics.some((d) => d.category === DiagnosticCategory.Error)) {
      return { typeCount: 0, emittedFiles: [], emitSkipped: true, diagnostics: tsDiagnostics };
    }

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

    let assembly: spec.Assembly;
    try {
      assembly = assembler.assemble();
    } catch (e: any) {
      // Same contract as the classic compiler: a failure while assembling is
      // reported as a JSII9997 error diagnostic rather than crashing the build.
      return {
        typeCount: 0,
        emittedFiles: [],
        emitSkipped: true,
        diagnostics: [
          ...tsDiagnostics,
          ...assembler.diagnostics,
          JsiiDiagnostic.JSII_9997_UNKNOWN_ERROR.createDetached(e),
        ],
      };
    }
    const jsiiDiagnostics = assembler.diagnostics;
    if (jsiiDiagnostics.some((d) => d.category === DiagnosticCategory.Error)) {
      return {
        typeCount: 0,
        emittedFiles: [],
        emitSkipped: true,
        diagnostics: [...tsDiagnostics, ...jsiiDiagnostics],
      };
    }

    if (process.env.JSII_TS7_TIMING) {
      LOG.info(`ts doc-cache hits (RPCs avoided): ${assembler.docCacheHits}`);
    }

    // Write the assembly first (the parity artifact), reusing @jsii/spec's writer
    // so the on-disk format (incl. the compressed file-redirect variant) matches
    // the strada path exactly.
    writeAssembly(projectRoot, fingerprint(assembly), { compress: options.compressAssembly ?? false });

    // Then emit JS/d.ts and inject jsii rtti (post-emit pass). An emit failure
    // fails the build (emitSkipped + a synthetic diagnostic); the assembly file
    // is left on disk to aid debugging, but the exit status reflects the error.
    let emittedFiles: string[] = [];
    try {
      ({ emittedFiles } = emitProject(project, {
        projectRoot,
        assembly,
        outDir: tscOutDir,
        rootDir: tscRootDir,
      }));
    } catch (err) {
      LOG.error(`ts backend: emit pipeline failed: ${(err as Error).stack ?? (err as Error).message}`);
      return {
        assembly,
        typeCount: Object.keys(assembly.types ?? {}).length,
        emittedFiles: [],
        emitSkipped: true,
        diagnostics: [syntheticErrorDiagnostic(`ts backend: emit pipeline failed: ${(err as Error).message}`)],
      };
    }

    return {
      assembly,
      typeCount: Object.keys(assembly.types ?? {}).length,
      emittedFiles,
      emitSkipped: false,
      diagnostics: [...tsDiagnostics, ...jsiiDiagnostics], // non-error diagnostics (warnings/suggestions) pass through
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
    host.close();
  }
}

/**
 * Collect the program's pre-emit diagnostics (options, global, syntactic and
 * semantic) from the program and map them to jsii's `Diagnostic` for the
 * standard reporting pipeline.
 */
function collectTsDiagnostics(program: any): Diagnostic[] {
  const call = (name: string): any[] => (typeof program[name] === 'function' ? program[name]() ?? [] : []);
  const raw: any[] = [
    ...call('getProgramDiagnostics'),
    ...call('getGlobalDiagnostics'),
    ...call('getSyntacticDiagnostics'),
    ...call('getSemanticDiagnostics'),
  ];
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
