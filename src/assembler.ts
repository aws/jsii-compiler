/*
 * ===========================================================================
 * The jsii Assembler: reads a TypeScript program through the TypeScript 7
 * programmatic API (the out-of-process `sync` client, see compiler-host.ts)
 * and produces the `spec.Assembly` (`.jsii`).
 *
 * The assembler reads the raw TypeScript 7 handles directly rather than
 * wrapping them to look like the in-process `ts.Program` / `ts.TypeChecker`
 * of TypeScript 6; the structure and method names of the previous
 * implementation (`_visitClass`, `_visitInterface`, `_visitEnum`,
 * `_visitMethod`, `_visitProperty`, `_visitDocumentation`) are kept so the
 * two can be compared. The `.jsii` it produces was compared field by field
 * with the previous implementation's on aws-cdk-lib and the fixtures.
 *
 * Not produced here (yet): the JSII_xxxx validation diagnostics of the
 * previous validator. TypeScript compilation errors are surfaced and fail the
 * build (see compiler.ts).
 * ===========================================================================
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as spec from '@jsii/spec';

import { findDependencyDirectory } from './common/find-utils';
import { symbolIdentifier } from './common/symbol-id';
import { TypeScriptApi, TypeScriptProject } from './compiler-host';
import { normalizeConfigPath } from './helpers';
import { JsiiDiagnostic } from './jsii-diagnostic';
import * as literate from './literate';
import { validateTargets, type ProjectInfo } from './project-info';
import { isAllowedCovariantSubtype } from './type-analysis';
import { createTypeResolver } from './type-reference';
import { SHORT_VERSION, VERSION } from './version';

<<<<<<< HEAD
=======
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const sortJson = require('sort-json');

const LOG = log4js.getLogger('jsii/assembler');

/**
 * The JSII Assembler consumes a ``ts.Program`` instance and emits a JSII assembly.
 */
export class Assembler implements Emitter {
  private readonly runtimeTypeInfoInjector: RuntimeTypeInfoInjector;
  private readonly deprecatedRemover?: DeprecatedRemover;
  private readonly warningsInjector?: DeprecationWarningsInjector;

  private readonly mainFile: string;
  private readonly tscRootDir?: string;
  private readonly tscOutDir?: string;
  /** Set when package.json's `types` is outside of tsc's outDir, to explain a missing `mainFile`. */
  private readonly typesOutsideOutDir?: { readonly types: string; readonly suggestion?: string };
  private readonly compressAssembly?: boolean;
  private readonly usedFeatures = new Set<spec.JsiiFeature>();

  private readonly _typeChecker: ts.TypeChecker;

  private _diagnostics = new Array<JsiiDiagnostic>();
  private _deferred = new Array<DeferredRecord>();
  private readonly _types = new Map<string, spec.Type>();
  private readonly _packageInfoCache = new Map<string, PackageJson | undefined>();

  /** Map of Symbol to namespace export Symbol */
  private readonly _submoduleMap = new Map<ts.Symbol, ts.Symbol>();

  /** Symbols reachable from the entry point's exports, including those of submodules and namespaces. */
  private _entryPointExports?: ReadonlySet<ts.Symbol>;

  /**
   * Submodule information
   *
   * Contains submodule information for all namespaces that have been seen
   * across all assemblies (this and dependencies).
   *
   * Filtered to local submodules only at time of writing the assembly out to disk.
   */
  private readonly _submodules = new Map<ts.Symbol, SubmoduleSpec>();

  private readonly _typeTracker = new TypeTracker();

  /**
   * @param projectInfo information about the package being assembled
   * @param program     the TypeScript program to be assembled from
   * @param stdlib      the directory where the TypeScript stdlib is rooted
   */
  public constructor(
    public readonly projectInfo: ProjectInfo,
    private readonly system: ts.System,
    public readonly program: ts.Program,
    public readonly stdlib: string,
    options: AssemblerOptions = {},
  ) {
    this._typeChecker = this.program.getTypeChecker();

    if (options.stripDeprecated) {
      let allowlistedDeprecations: Set<string> | undefined;
      if (options.stripDeprecatedAllowListFile) {
        if (!fs.existsSync(options.stripDeprecatedAllowListFile)) {
          throw new JsiiError(`--strip-deprecated file not found: ${options.stripDeprecatedAllowListFile}`);
        }
        allowlistedDeprecations = new Set<string>(
          fs.readFileSync(options.stripDeprecatedAllowListFile, 'utf8').split('\n'),
        );
      }

      this.deprecatedRemover = new DeprecatedRemover(this._typeChecker, allowlistedDeprecations);
    }

    if (options.addDeprecationWarnings) {
      this.warningsInjector = new DeprecationWarningsInjector(this._typeChecker, this._typeTracker);
    }

    this.compressAssembly = options.compressAssembly;

    const dts = projectInfo.types ?? 'index.d.ts';
    let mainFile = dts.replace(/\.d\.ts(x?)$/, '.ts$1');

    // If out-of-source build was configured (tsc's outDir and rootDir), the
    // main file's path needs to be re-rooted from the outDir into the rootDir.
    // outDir might be also be absolute, so we need to normalize it.
    this.tscOutDir = normalizeConfigPath(projectInfo.projectRoot, program.getCompilerOptions().outDir);
    if (this.tscOutDir != null) {
      mainFile = path.relative(this.tscOutDir, mainFile);
      const typesOutsideOutDir = isOutsideOfDirectory(mainFile);

      // rootDir may be set explicitly or not. If not, inferRootDir replicates
      // tsc's behavior of using the longest prefix of all built source files.
      // rootDir might also be absolute (just like outDir), so we normalize it
      // to be relative to the package root. Otherwise the absolute path leaks
      // into the assembly's `metadata.tscRootDir`, which breaks the
      // reproducibility/fingerprint check for downstream consumers.
      this.tscRootDir = normalizeConfigPath(
        projectInfo.projectRoot,
        program.getCompilerOptions().rootDir ?? inferRootDir(program),
      );
      if (this.tscRootDir != null) {
        mainFile = path.join(this.tscRootDir, mainFile);
      }

      if (typesOutsideOutDir) {
        // tsc writes declarations into outDir, so `types` can't be re-rooted from it, and the entry point is usually
        // looked up in the wrong place. Remember where tsc puts the declarations, to report that if it is not found.
        const fromRootDir = path.relative(this.tscRootDir ?? '.', dts);
        this.typesOutsideOutDir = {
          types: dts,
          suggestion: isOutsideOfDirectory(fromRootDir) ? undefined : path.join(this.tscOutDir, fromRootDir),
        };
      }
    }

    this.mainFile = path.resolve(projectInfo.projectRoot, mainFile);
    this.runtimeTypeInfoInjector = new RuntimeTypeInfoInjector(projectInfo.version);
  }

  public get customTransformers(): ts.CustomTransformers {
    return combinedTransformers(
      this.deprecatedRemover?.customTransformers ?? {},
      this.runtimeTypeInfoInjector.makeTransformers(),
      this.warningsInjector?.customTransformers ?? {},
    );
  }

  /**
   * Attempt emitting the JSII assembly for the program.
   *
   * @return the result of the assembly emission.
   */
  public emit(): ts.EmitResult {
    if (!this.projectInfo.description) {
      this._diagnostics.push(JsiiDiagnostic.JSII_0001_PKG_MISSING_DESCRIPTION.createDetached());
    }
    if (!this.projectInfo.homepage) {
      this._diagnostics.push(JsiiDiagnostic.JSII_0002_PKG_MISSING_HOMEPAGE.createDetached());
    }
    const readme = _loadReadme.call(this);
    if (readme == null) {
      this._diagnostics.push(JsiiDiagnostic.JSII_0003_MISSING_README.createDetached());
    }
    const docs = _loadDocs.call(this);

    const sourceFile = this.program.getSourceFile(this.mainFile);

    if (sourceFile == null && this.typesOutsideOutDir != null) {
      this._diagnostics.push(
        JsiiDiagnostic.JSII_0008_TYPES_OUTSIDE_OUT_DIR.createDetached(
          this.typesOutsideOutDir.types,
          this.tscOutDir!,
          this.typesOutsideOutDir.suggestion,
        ),
      );
    } else if (sourceFile == null) {
      this._diagnostics.push(JsiiDiagnostic.JSII_0004_COULD_NOT_FIND_ENTRYPOINT.createDetached(this.mainFile));
    } else {
      this._registerDependenciesNamespaces(sourceFile);

      if (LOG.isTraceEnabled()) {
        LOG.trace(
          `Processing source file: ${chalk.blue(path.relative(this.projectInfo.projectRoot, sourceFile.fileName))}`,
        );
      }
      const symbol = this._typeChecker.getSymbolAtLocation(sourceFile);
      if (symbol) {
        this._entryPointExports = this._collectEntryPointExports(symbol);
        const moduleExports = this._typeChecker.getExportsOfModule(symbol);
        moduleExports.map((item) => this._registerNamespaces(item, this.projectInfo.projectRoot));
        for (const node of moduleExports) {
          const decl = node.declarations?.[0];
          if (decl == null) {
            continue;
          }
          this._visitNode(decl, new EmitContext([], this.projectInfo.stability));
        }
      }
    }

    this.callDeferredsInOrder();

    this.validateTypesAgainstPositions();

    this.validateSubmoduleConfigs();

    // Skip emitting if any diagnostic message is an error
    if (this._diagnostics.find((diag) => diag.category === ts.DiagnosticCategory.Error) != null) {
      LOG.debug('Skipping emit due to errors.');
      try {
        return { diagnostics: this._diagnostics, emitSkipped: true };
      } finally {
        // Clearing ``this._diagnostics`` to allow contents to be garbage-collected.
        this._afterEmit();
      }
    }

    const jsiiVersion = this.projectInfo.jsiiVersionFormat === 'short' ? SHORT_VERSION : VERSION;

    const assembly: spec.Assembly = {
      schema: spec.SchemaVersion.LATEST,
      name: this.projectInfo.name,
      version: this.projectInfo.version,
      description: this.projectInfo.description ?? this.projectInfo.name,
      license: this.projectInfo.license,
      keywords: this.projectInfo.keywords && Array.from(this.projectInfo.keywords),
      homepage: this.projectInfo.homepage ?? this.projectInfo.repository.url,
      author: this.projectInfo.author,
      contributors: this.projectInfo.contributors && [...this.projectInfo.contributors],
      repository: this.projectInfo.repository,
      dependencies: noEmptyDict({
        ...this.projectInfo.dependencies,
        ...this.projectInfo.peerDependencies,
      }),
      dependencyClosure: noEmptyDict(toDependencyClosure(this.projectInfo.dependencyClosure)),
      bundled: this.projectInfo.bundleDependencies,
      types: Object.fromEntries(this._types),
      submodules: noEmptyDict(toSubmoduleDeclarations(this.mySubmodules())),

      // Force this into shape
      targets: this.projectInfo.targets as spec.Assembly['targets'],

      metadata: {
        ...this.projectInfo.metadata,

        // Downstream consumers need these to map a symbolId in the outDir to a
        // symbolId in the rootDir. They cannot always be recovered from the
        // consumed package's `package.json` (e.g. when the package was built
        // with a user-provided `tsconfig.json` via `jsii.tsconfig`), so they
        // must be recorded in the assembly itself.
        tscRootDir: this.tscRootDir,
        tscOutDir: this.tscOutDir,
      },
      docs,
      readme,
      jsiiVersion,
      bin: this.projectInfo.bin,
      fingerprint: '<TBD>',
      usedFeatures: _assemblyFeatures(this.usedFeatures), // might be appended later
    };

    if (this.deprecatedRemover) {
      this._diagnostics.push(...this.deprecatedRemover.removeFrom(assembly));
    }

    if (this.warningsInjector) {
      const jsiiMetadata = {
        ...(assembly.metadata?.jsii ?? {}),
        ...{ compiledWithDeprecationWarnings: true },
      };

      if (assembly.metadata) {
        assembly.metadata.jsii = jsiiMetadata;
      } else {
        assembly.metadata = { jsii: jsiiMetadata };
      }
      this.warningsInjector.process(assembly, this.projectInfo);
    }

    const validator = new Validator(this.projectInfo, assembly);
    const validationResult = validator.emit();

    // Inject detected features
    if (validationResult.usedFeatures) {
      for (const item of validationResult.usedFeatures) {
        this.usedFeatures.add(item);
      }
      assembly.usedFeatures = _assemblyFeatures(this.usedFeatures);
    }

    if (!validationResult.emitSkipped) {
      const zipped = writeAssembly(this.projectInfo.projectRoot, _fingerprint(assembly), {
        compress: this.compressAssembly ?? false,
      });
      LOG.trace(
        `${zipped ? 'Zipping' : 'Emitting'} assembly: ${chalk.blue(
          path.join(this.projectInfo.projectRoot, SPEC_FILE_NAME),
        )}`,
      );
    }

    try {
      return {
        diagnostics: [...this._diagnostics, ...validationResult.diagnostics],
        emitSkipped: validationResult.emitSkipped,
      };
    } finally {
      this._afterEmit();
    }

    function _assemblyFeatures(usedFeatures: Set<spec.JsiiFeature>): spec.JsiiFeature[] | undefined {
      return usedFeatures.size > 0 ? Array.from(usedFeatures).sort() : undefined;
    }

    function _loadReadme(this: Assembler) {
      // Search for `README.md` in a case-insensitive way
      const fileName = fs
        .readdirSync(this.projectInfo.projectRoot)
        .find((file) => file.toLocaleLowerCase() === 'readme.md');
      if (fileName == null) {
        return undefined;
      }
      const readmePath = path.join(this.projectInfo.projectRoot, fileName);
      return loadAndRenderReadme(readmePath, this.projectInfo.projectRoot);
    }

    function _loadDocs(this: Assembler): spec.Docs | undefined {
      if (!this.projectInfo.stability && !this.projectInfo.deprecated) {
        return undefined;
      }
      const deprecated = this.projectInfo.deprecated;
      const stability = this.projectInfo.stability;
      return { deprecated, stability };
    }
  }

  private _afterEmit() {
    this._diagnostics = [];
    this._deferred = [];
    this._types.clear();
    this._submoduleMap.clear();
    this._submodules.clear();
    this._packageInfoCache.clear();
  }

  /**
   * Defer a callback until a (set of) types are available
   *
   * This is a helper function around _defer() which encapsulates the _dereference
   * action (which is basically the majority use case for _defer anyway).
   *
   * Will not invoke the function with any 'undefined's; an error will already have been emitted in
   * that case anyway.
   *
   * @param fqn FQN of the current type (the type that has a dependency on baseTypes)
   * @param baseTypes Array of type references to be looked up
   * @param referencingNode Node to report a diagnostic on if we fail to look up a type
   * @param cb Callback to be invoked with the Types corresponding to the TypeReferences in baseTypes
   */
  private _deferUntilTypesAvailable(
    fqn: string,
    baseTypes: Array<string | spec.TypeReference>,
    referencingNode: ts.Node | undefined,
    cb: (...xs: spec.Type[]) => void,
  ) {
    // We can do this one eagerly
    if (baseTypes.length === 0) {
      cb();
      return;
    }
    const baseFqns = baseTypes.flatMap((bt) => {
      if (typeof bt === 'string') {
        return [bt];
      }
      if (spec.isNamedTypeReference(bt)) {
        return [bt.fqn];
      }
      return [];
    });

    this._defer(fqn, baseFqns, () => {
      const resolved = baseFqns
        .map((x) => this._dereference(x, referencingNode, 'used-in-syntax'))
        .filter((x) => x !== undefined);
      if (resolved.length > 0) {
        cb(...(resolved as spec.Type[]));
      }
    });
  }

  /**
   * Defer checks for after the program has been entirely processed; useful for verifying type references that may not
   * have been discovered yet, and verifying properties about them.
   *
   * The callback is guaranteed to be executed only after all deferreds for all types in 'dependedFqns' have
   * been executed.
   *
   * @param fqn FQN of the current type.
   * @param dependedFqns List of FQNs of types this callback depends on. All deferreds for all
   * @param cb the function to be called in a deferred way. It will be bound with ``this``, so it can depend on using
   *           ``this``.
   */
  private _defer(fqn: string, dependedFqns: string[], cb: () => void) {
    this._deferred.push({ fqn, dependedFqns, cb: cb.bind(this) });
  }

  /**
   * Obtains the ``spec.Type`` for a given ``spec.NamedTypeReference``.
   *
   * @param ref the type reference to be de-referenced
   *
   * @returns the de-referenced type, if it was found, otherwise ``undefined``.
   */
  private _dereference(
    ref: string | spec.NamedTypeReference,
    referencingNode: ts.Node | undefined,
    usedInSyntax: 'used-in-syntax' | 'just-validating',
  ): spec.Type | undefined {
    if (typeof ref !== 'string') {
      ref = ref.fqn;
    }

    const [assm] = ref.split('.');
    let type;
    if (assm === this.projectInfo.name) {
      type = this._types.get(ref);
    } else {
      const assembly = this.projectInfo.dependencyClosure.find((dep) => dep.name === assm);
      type = assembly?.types?.[ref];

      // since we are exposing a type of this assembly in this module's public API,
      // we expect it to appear as a peer dependency instead of a normal dependency.
      if (assembly) {
        if (!(assembly.name in this.projectInfo.peerDependencies)) {
          this._diagnostics.push(
            JsiiDiagnostic.JSII_0005_MISSING_PEER_DEPENDENCY.create(
              referencingNode!, // Cheating here for now, until the referencingNode can be made required
              assembly.name,
              ref,
            ),
          );
        }
      }
    }

    if (!type && usedInSyntax === 'used-in-syntax') {
      this._diagnostics.push(
        JsiiDiagnostic.JSII_9002_UNRESOLVEABLE_TYPE.create(
          referencingNode!, // Cheating here for now, until the referencingNode can be made required
          ref,
        ),
      );
    }

    return type;
  }

  /**
   * Compute the JSII fully qualified name corresponding to a ``ts.Type`` instance. If for any reason a name cannot be
   * computed for the type, a marker is returned instead, and an ``ts.DiagnosticCategory.Error`` diagnostic is
   * inserted in the assembler context.
   *
   * @param type the type for which a JSII fully qualified name is needed.
   * @param typeAnnotationNode the type annotation for which this FQN is generated. This is used for attaching the error
   *                           marker. When there is no explicit type annotation (e.g: inferred method return type), the
   *                           preferred substitute is the "type-inferred" element's name.
   * @param typeUse the reason why this type was resolved (e.g: "return type")
   * @param isThisType whether this type was specified or inferred as "this" or not
   *
   * @returns the FQN of the type, or some "unknown" marker.
   */
  private _getFQN(
    type: ts.Type,
    typeAnnotationNode: ts.Node | undefined,
    typeUse: TypeUseKind,
    isThisType: boolean,
  ): string | undefined {
    const sym = symbolFromType(type, this._typeChecker);
    const typeDeclaration = sym.valueDeclaration ?? sym.declarations?.[0];

    // Set to true to prevent further adding of Error diagnostics for known-bad reference
    let hasError = false;

    if (this._isPrivateOrInternal(sym)) {
      // Check if this type is "this" (explicit or inferred method return type).
      this._diagnostics.push(
        JsiiDiagnostic.JSII_3001_EXPOSED_INTERNAL_TYPE.create(
          typeAnnotationNode,
          sym,
          isThisType,
          typeUse,
        ).addRelatedInformationIf(typeDeclaration, 'The referenced type is declared here'),
      );

      hasError = true;
    }

    const tsName = this._typeChecker.getFullyQualifiedName(sym);
    const groups = /^"([^"]+)"\.(.*)$/.exec(tsName);
    if (!groups) {
      if (!hasError) {
        this._diagnostics.push(
          JsiiDiagnostic.JSII_3001_EXPOSED_INTERNAL_TYPE.create(
            typeAnnotationNode,
            sym,
            isThisType,
            typeUse,
          ).addRelatedInformationIf(typeDeclaration, 'The referenced type is declared here'),
        );
        hasError = true;
      }
      return tsName;
    }
    const [, modulePath, typeName] = groups;
    const pkg = this.findPackageInfo(modulePath);
    if (!pkg) {
      if (!hasError) {
        this._diagnostics.push(
          JsiiDiagnostic.JSII_9003_UNRESOLVEABLE_MODULE.create(typeAnnotationNode, modulePath).addRelatedInformationIf(
            typeDeclaration,
            'The referenced type is declared here',
          ),
        );
        hasError = true;
      }
      return `unknown.${typeName}`;
    }

    // If the symbol comes from an assembly whose submodules we've already
    // spidered (or from the current assembly), look up there. This relies
    // on an entry-point import of the library having been done first
    // (`import * as x from 'module-root';`)
    const submodule = this._submoduleMap.get(sym);
    if (submodule != null) {
      const submoduleNs = this._submodules.get(submodule)!.fqnResolutionPrefix;
      return `${submoduleNs}.${typeName}`;
    }

    // This is the fallback: in case we can't find a symbolId for the given
    // type, we're return this value. This is for backwards compatibility with
    // modules that haven't been compiled to have symbolId support. Those also
    // most likely won't be using submodules so this legacy guess will be correct.
    const fallbackFqn = `${pkg.name}.${typeName}`;

    // If the type is coming from the current module, we won't find it in a dependency
    if (pkg.name === this.projectInfo.name) {
      return fallbackFqn;
    }

    // Otherwise look up the symbol identifier in the dependency assemblies
    // This is now the preferred mechanism but we can't do this as the only mechanism,
    // as we may still have compile against very old assemblies that don't have a
    // symbol identifier table at all.
    const dep = this.projectInfo.dependencyClosure.find((d) => d.name === pkg.name);
    if (!dep) {
      this._diagnostics.push(JsiiDiagnostic.JSII_9000_UNKNOWN_MODULE.create(typeAnnotationNode, pkg.name));
      return fallbackFqn;
    }
    const symbolId = symbolIdentifier(this._typeChecker, sym, {
      assembly: dep,
    });
    const fqn = (dep && symbolId ? symbolIdIndex(dep)[symbolId] : undefined) ?? fallbackFqn;

    if (!fqn || !this._dereference({ fqn }, sym.valueDeclaration, 'used-in-syntax')) {
      if (!hasError) {
        this._diagnostics.push(
          JsiiDiagnostic.JSII_3002_USE_OF_UNEXPORTED_FOREIGN_TYPE.create(
            typeAnnotationNode,
            fqn ?? tsName,
            typeUse,
            pkg,
          ).addRelatedInformationIf(typeDeclaration, 'The referenced type is declared here'),
        );
        hasError = true;
      }
    }

    return fqn;
  }

  /**
   * For all modules in the dependency closure, crawl their exports to register
   * the submodules they contain.
   *
   * @param entryPoint the main source file for the currently compiled module.
   */
  private _registerDependenciesNamespaces(entryPoint: ts.SourceFile) {
    for (const assm of this.projectInfo.dependencyClosure) {
      const resolved = ts.resolveModuleName(assm.name, entryPoint.fileName, this.program.getCompilerOptions(), ts.sys);
      // If we can't resolve the module name, simply ignore it (TypeScript compilation likely failed)
      if (resolved.resolvedModule == null) {
        continue;
      }
      const source = this.program.getSourceFile(resolved.resolvedModule.resolvedFileName);
      const depMod = source && this._typeChecker.getSymbolAtLocation(source);
      // It's unlikely, but if we can't get the SourceFile here, ignore it (TypeScript compilation probably failed)
      if (depMod == null) {
        continue;
      }

      const depRoot = packageRoot(resolved.resolvedModule.resolvedFileName);

      for (const symbol of this._typeChecker.getExportsOfModule(depMod)) {
        this._registerNamespaces(symbol, depRoot);
      }
    }

    function packageRoot(file: string): string {
      const parent = path.dirname(file);
      if (path.basename(parent) === 'node_modules' || parent === file) {
        return file;
      }
      return packageRoot(parent);
    }
  }

  private _registerNamespaces(symbol: ts.Symbol, packageRoot: string): void {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (declaration == null) {
      // Nothing to do here...
      return;
    }
    if (ts.isModuleDeclaration(declaration)) {
      // Looks like:
      //
      //    export some_namespace {
      //       ...
      //    }
      //
      // No way to configure targets

      const { fqn, fqnResolutionPrefix } = qualifiedNameOf.call(this, symbol, true);

      this._submodules.set(symbol, {
        fqn,
        fqnResolutionPrefix,
        symbolId: symbolIdentifier(this._typeChecker, symbol),
        locationInModule: this.declarationLocation(declaration),
      });
      this._addToSubmodule(symbol, symbol, packageRoot);
      return;
    }
    if (!ts.isNamespaceExport(declaration)) {
      // Nothing to do here...
      return;
    }

    const moduleSpecifier = declaration.parent.moduleSpecifier;
    if (moduleSpecifier == null || !ts.isStringLiteral(moduleSpecifier)) {
      // There is a grammar error here, so we'll let tsc report this for us.
      return;
    }
    const resolution = ts.resolveModuleName(
      moduleSpecifier.text,
      declaration.getSourceFile().fileName,
      this.program.getCompilerOptions(),
      this.system,
    );
    if (resolution.resolvedModule == null) {
      // Unresolvable module... We'll let tsc report this for us.
      return;
    }

    if (
      // We're not looking into a dependency's namespace exports, and the resolution says it's external
      (packageRoot === this.projectInfo.projectRoot && resolution.resolvedModule.isExternalLibraryImport) ||
      // Or the module resolves outside of the current dependency's tree entirely
      !isUnder(resolution.resolvedModule.resolvedFileName, packageRoot) ||
      // Or the module is under one the current dependency's node_modules subtree
      resolution.resolvedModule.resolvedFileName
        .split('/') // Separator is always '/', even on Windows
        .filter((entry) => entry === 'node_modules').length !==
        packageRoot.split('/').filter((entry) => entry === 'node_modules').length
    ) {
      // External re-exports are "pure-javascript" sugar; they need not be
      // represented in the jsii Assembly since the types in there will be
      // resolved through dependencies.
      return;
    }

    const sourceFile = this.program.getSourceFile(resolution.resolvedModule.resolvedFileName)!;
    const sourceModule = this._typeChecker.getSymbolAtLocation(sourceFile);
    // If there's no module, it's a syntax error, and tsc will have reported it for us.
    if (sourceModule) {
      if (symbol.name !== Case.camel(symbol.name) && symbol.name !== Case.snake(symbol.name)) {
        this._diagnostics.push(JsiiDiagnostic.JSII_8004_SUBMOULE_NAME_CASING.create(declaration.name, symbol.name));
      }

      const { fqn, fqnResolutionPrefix } = qualifiedNameOf.call(this, symbol);
      const targets = loadSubmoduleTargetConfig(sourceFile.fileName);
      // There is no need to process the README file for submodules that are
      // external (i.e: from a dependency), as these will not be emitted in the
      // assembly. That'd be wasted effort, and could fail if the README file
      // refers to literate examples that are not packaged in the dependency.
      const readme =
        packageRoot === this.projectInfo.projectRoot
          ? loadSubmoduleReadMe(sourceFile.fileName, this.projectInfo.projectRoot)
          : undefined;

      this._submodules.set(symbol, {
        fqn,
        fqnResolutionPrefix,
        targets,
        readme,
        symbolId: symbolIdentifier(this._typeChecker, symbol),
        locationInModule: this.declarationLocation(declaration),
      });
      this._addToSubmodule(symbol, sourceModule, packageRoot);
    }

    function qualifiedNameOf(
      this: Assembler,
      sym: ts.Symbol,
      inlineNamespace = false,
    ): { fqn: string; fqnResolutionPrefix: string } {
      if (this._submoduleMap.has(sym)) {
        const parent = this._submodules.get(this._submoduleMap.get(sym)!)!;
        const fqn = `${parent.fqn}.${sym.name}`;
        return {
          fqn,
          fqnResolutionPrefix: inlineNamespace ? parent.fqnResolutionPrefix : fqn,
        };
      }
      const symbolLocation = sym.getDeclarations()?.[0]?.getSourceFile()?.fileName;
      const pkgInfo = symbolLocation ? this.findPackageInfo(symbolLocation) : undefined;
      const assemblyName: string = pkgInfo?.name ?? this.projectInfo.name;
      const fqn = `${assemblyName}.${sym.name}`;
      return {
        fqn,
        fqnResolutionPrefix: inlineNamespace ? this.projectInfo.name : fqn,
      };
    }

    function loadSubmoduleTargetConfig(submoduleMain: string): SubmoduleSpec['targets'] {
      const dirname = path.dirname(submoduleMain);
      const basenameWithoutExtension = path.basename(submoduleMain).replace(/\.ts$/, '');

      let jsiirc;
      if (basenameWithoutExtension === 'index') {
        jsiirc = path.resolve(submoduleMain, '..', '.jsiirc.json');
      } else {
        jsiirc = path.resolve(dirname, `.${basenameWithoutExtension}.jsiirc.json`);
      }

      if (!jsiirc || !fs.existsSync(jsiirc)) {
        return undefined;
      }
      const data = JSON.parse(fs.readFileSync(jsiirc, 'utf-8'));
      return validateTargets(data.targets as AssemblyTargets) as SubmoduleSpec['targets'];
    }

    /**
     * Load the README for the given submodule
     *
     * If the submodule is loaded from a complete directory (determined by the 'main'
     * file ending in `index.[d.]ts`, then we load `README.md` in that same directory.
     *
     * If the submodule is loaded from a file, like `mymodule.[d.]ts`, we will load
     * `mymodule.README.md`.
     */
    function loadSubmoduleReadMe(submoduleMain: string, projectRoot: string): SubmoduleSpec['readme'] {
      const fileBase = path.basename(submoduleMain).replace(/(\.d)?\.ts$/, '');
      const readMeName = fileBase === 'index' ? 'README.md' : `${fileBase}.README.md`;
      const fullPath = path.join(path.dirname(submoduleMain), readMeName);
      return loadAndRenderReadme(fullPath, projectRoot);
    }
  }

  /**
   * Registers Symbols to a particular submodule. This is used to associate
   * declarations exported by an `export * as ns from 'moduleLike';` statement
   * so that they can subsequently be correctly namespaced.
   *
   * @param ns          the symbol that identifies the submodule.
   * @param moduleLike  the module-like symbol bound to the submodule.
   * @param packageRoot the root of the package being traversed.
   */
  private _addToSubmodule(ns: ts.Symbol, moduleLike: ts.Symbol, packageRoot: string) {
    // For each symbol exported by the moduleLike, map it to the ns submodule.
    for (const symbol of this._typeChecker.getExportsOfModule(moduleLike)) {
      if (this._submoduleMap.has(symbol)) {
        const currNs = this._submoduleMap.get(symbol)!;
        // Checking if there's been two submodules exporting the same symbol,
        // which is illegal. We can tell if the currently registered symbol has
        // a different name than the one we're currently trying to register in.
        if (currNs.name !== ns.name) {
          const currNsDecl = currNs.valueDeclaration ?? currNs.declarations?.[0];
          const nsDecl = ns.valueDeclaration ?? ns.declarations?.[0];

          // Make sure the error message always lists causes in the same order
          const refs = [
            { decl: currNsDecl, name: currNs.name } as const,
            { decl: nsDecl, name: ns.name } as const,
          ].sort(({ name: l }, { name: r }) => l.localeCompare(r));

          this._diagnostics.push(
            JsiiDiagnostic.JSII_3003_SYMBOL_IS_EXPORTED_TWICE.create(
              _nameOrDeclarationNode(symbol),
              refs[0].name,
              refs[1].name,
            )
              .addRelatedInformationIf(refs[0].decl, `Symbol is exported under the "${refs[0].name}" submodule`)
              .addRelatedInformationIf(refs[1].decl, `Symbol is exported under the "${refs[1].name}" submodule`),
          );
        }
        // Found two re-exports, which is odd, but they use the same submodule,
        // so it's probably okay? That's likely a tsc error, which will have
        // been reported for us already anyway.
        continue;
      }
      this._submoduleMap.set(symbol, ns);

      // If the exported symbol has any declaration, and that delcaration is of
      // an entity that can have nested declarations of interest to jsii
      // (classes, interfaces, enums, modules), we need to also associate those
      // nested symbols to the submodule (or they won't be named correctly!)
      const decl = symbol.declarations?.[0];
      if (decl != null) {
        if (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl) || ts.isEnumDeclaration(decl)) {
          const type = this._typeChecker.getTypeAtLocation(decl);
          if (isSingleValuedEnum(type, this._typeChecker)) {
            // type.symbol !== symbol, because symbol is the enum itself, but
            // since it's single-valued, the TypeChecker will only show us the
            // value's symbol later on.
            this._submoduleMap.set(type.symbol, ns);
          }
          if (type.symbol.exports) {
            // eslint-disable-next-line no-await-in-loop
            this._addToSubmodule(ns, symbol, packageRoot);
          }
        } else if (ts.isModuleDeclaration(decl)) {
          // eslint-disable-next-line no-await-in-loop
          this._registerNamespaces(symbol, packageRoot);
        } else if (ts.isNamespaceExport(decl)) {
          // eslint-disable-next-line no-await-in-loop
          this._registerNamespaces(symbol, packageRoot);
        }
      }
    }
  }

  /**
   * Register exported types in ``this.types``.
   *
   * @param node       a node found in a module
   * @param namePrefix the prefix for the types' namespaces
   */
  // eslint-disable-next-line complexity
  private _visitNode(node: ts.Declaration, context: EmitContext): spec.Type[] {
    if (ts.isNamespaceExport(node)) {
      // export * as ns from 'module';
      // Note: the "ts.NamespaceExport" refers to the "export * as ns" part of
      // the statement only. We must refer to `node.parent` in order to be able
      // to access the module specifier ("from 'module'") part.
      const symbol = this._typeChecker.getSymbolAtLocation(node.parent.moduleSpecifier!)!;

      if (LOG.isTraceEnabled()) {
        LOG.trace(`Entering submodule: ${chalk.cyan([...context.namespace, symbol.name].join('.'))}`);
      }

      const nsContext = context.appendNamespace(node.name.text);
      const allTypes = this._typeChecker.getExportsOfModule(symbol).flatMap((child) => {
        const decl = child.declarations?.[0];
        if (decl == null) {
          return [];
        }
        return this._visitNode(decl, nsContext);
      });

      if (LOG.isTraceEnabled()) {
        LOG.trace(`Leaving submodule: ${chalk.cyan([...context.namespace, symbol.name].join('.'))}`);
      }

      return allTypes;
    }

    if (ts.isExportSpecifier(node)) {
      // This is what happens when one does `export { Symbol } from "./location";`
      //                   ExportSpecifier:           ~~~~~~

      const resolvedSymbol = this._typeChecker.getExportSpecifierLocalTargetSymbol(node);
      const decl = resolvedSymbol?.valueDeclaration ?? resolvedSymbol?.declarations?.[0];
      if (!decl) {
        // A grammar error, compilation will already have failed
        return [];
      }
      return this._visitNode(decl, context);
    }

    if ((ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) === 0) {
      return [];
    }

    // Early exit if the declaration is marked with `@jsii ignore`. We resolve the
    // symbol and require *every* declaration to be ignored (see `_isIgnored`) so
    // this stays consistent with how references are resolved; otherwise a
    // partially-ignored merged declaration would be dropped here but treated as
    // public elsewhere. Without this, deriving from a `Partial<T>` would also
    // raise spurious compiler errors on an ignored declaration.
    const nodeSymbol = this._typeChecker.getSymbolAtLocation(ts.getNameOfDeclaration(node) ?? node);
    const isIgnored =
      nodeSymbol != null
        ? this._isIgnored(nodeSymbol)
        : Directives.of(node, (diag) => this._diagnostics.push(diag)).ignore != null;
    if (isIgnored) {
      return [];
    }

    let jsiiType: spec.Type | undefined;

    if (ts.isClassDeclaration(node) && _isExported(node)) {
      // export class Name { ... }
      this._validateHeritageClauses(node.heritageClauses);

      jsiiType = this._visitClass(this._typeChecker.getTypeAtLocation(node), context);
      if (jsiiType) {
        this.registerExportedClassFqn(node, jsiiType.fqn);
      }
    } else if (ts.isInterfaceDeclaration(node) && _isExported(node)) {
      // export interface Name { ... }
      this._validateHeritageClauses(node.heritageClauses);
      jsiiType = this._visitInterface(this._typeChecker.getTypeAtLocation(node), context);
    } else if (ts.isEnumDeclaration(node) && _isExported(node)) {
      // export enum Name { ... }
      jsiiType = this._visitEnum(this._typeChecker.getTypeAtLocation(node), context);
    } else if (ts.isModuleDeclaration(node)) {
      // export namespace name { ... }
      const name = node.name.getText();
      const symbol = this._typeChecker.getSymbolAtLocation(node.name)!;

      if (LOG.isTraceEnabled()) {
        LOG.trace(`Entering namespace: ${chalk.cyan([...context.namespace, name].join('.'))}`);
      }

      const nsContext = context.appendNamespace(node.name.getText());
      const allTypes = this._typeChecker.getExportsOfModule(symbol).flatMap((prop) => {
        const decl = prop.declarations?.[0];
        if (decl == null) {
          return [];
        }
        return this._visitNode(decl, nsContext);
      });

      if (LOG.isTraceEnabled()) {
        LOG.trace(`Leaving namespace:  ${chalk.cyan([...context.namespace, name].join('.'))}`);
      }
      return allTypes;
    } else {
      this._diagnostics.push(
        JsiiDiagnostic.JSII_9998_UNSUPPORTED_NODE.create(ts.getNameOfDeclaration(node) ?? node, node.kind),
      );
    }

    if (!jsiiType) {
      return [];
    }

    // If symbolId hasn't been set yet, set it here
    if (!jsiiType.symbolId) {
      jsiiType.symbolId = this.getSymbolId(node);
    }

    // Verify the declaration does not collide with a submodule at the same level in the hierarchy.
    // Submodules get case-adjusted per target language, so names cannot collide with case-variations.
    // We only check submodules and types with a shared parent namespace. Symbols at different nesting
    // levels should not conflict with each other. E.g. "pkg.MyType" and "pkg.sub.my_type" are okay.
    const typeFqnPrefix = parentFqn(jsiiType.fqn);
    for (const [submodule, submoduleSpec] of this._submodules.entries()) {
      // Only check submodules that share the same parent namespace as the type
      if (typeFqnPrefix !== parentFqn(submoduleSpec.fqn)) {
        continue;
      }

      // We build common variations of the submodule name to simulate what they would be called in various target languages.
      // This is not entirely accurate because submodules may actually be renamed via .jsiirc files.
      // It is however a good enough approximation for the compiler.
      const candidates = Array.from(
        new Set([submodule.name, Case.camel(submodule.name), Case.pascal(submodule.name), Case.snake(submodule.name)]),
      );
      if (candidates.some((name) => name === jsiiType!.name)) {
        this._diagnostics.push(
          JsiiDiagnostic.JSII_5011_SUBMODULE_NAME_CONFLICT.create(
            ts.getNameOfDeclaration(node) ?? node,
            submodule.name,
            jsiiType.name,
            candidates,
          ).addRelatedInformationIf(_nameOrDeclarationNode(submodule), 'This is the conflicting submodule declaration'),
        );
      }
    }

    if (LOG.isInfoEnabled()) {
      LOG.info(`Registering JSII ${chalk.magenta(jsiiType.kind)}: ${chalk.green(jsiiType.fqn)}`);
    }
    this._types.set(jsiiType.fqn, jsiiType);
    jsiiType.locationInModule = this.declarationLocation(node);

    const type = this._typeChecker.getTypeAtLocation(node);
    if (type.symbol.exports) {
      const nestedContext = context.appendNamespace(type.symbol.name);
      const visitedNodes = this._typeChecker
        .getExportsOfModule(type.symbol)
        .filter((s) => s.declarations)
        .flatMap((exportedNode) => {
          const decl = exportedNode.valueDeclaration ?? exportedNode.declarations?.[0];
          if (decl == null) {
            return [];
          }
          return [this._visitNode(decl, nestedContext)];
        });
      for (const nestedTypes of visitedNodes) {
        for (const nestedType of nestedTypes) {
          if (nestedType.namespace !== nestedContext.namespace.join('.')) {
            this._diagnostics.push(
              JsiiDiagnostic.JSII_5012_NAMESPACE_IN_TYPE.create(
                ts.getNameOfDeclaration(node) ?? node,
                jsiiType.fqn,
                nestedType.namespace!,
              ),
            );
          }
        }
      }
    }

    return [jsiiType];
  }

  private getSymbolId(node: ts.Node) {
    return symbolIdentifier(this._typeChecker, this._typeChecker.getTypeAtLocation(node).symbol);
  }

  private _validateHeritageClauses(clauses?: ts.NodeArray<ts.HeritageClause>) {
    if (clauses == null || clauses.length === 0) {
      // Nothing to do.
      return;
    }
    for (const clause of clauses) {
      for (const node of clause.types) {
        const parentType = this._typeChecker.getTypeAtLocation(node);
        if (parentType.symbol == null) {
          // The parent type won't have a symbol if it's an "error type" inserted by the type checker when the original
          // code contains a compilation error. In such cases, the TypeScript compiler will already have reported about
          // the incoherent declarations, so we'll just not re-validate it there (we'd fail anyway).
          continue;
        }
        // For some reason, we cannot trust parentType.isClassOrInterface()
        const badDecl = parentType.symbol.declarations?.find(
          (decl) =>
            !ts.isClassDeclaration(decl) && // <-- local classes
            !ts.isInterfaceDeclaration(decl) && // <-- local interfaces
            !ts.isModuleDeclaration(decl), // <-- imported types
        );
        if (badDecl != null) {
          this._diagnostics.push(
            JsiiDiagnostic.JSII_3004_INVALID_SUPERTYPE.create(node, clause, badDecl).addRelatedInformation(
              badDecl,
              'The invalid super type is declared here.',
            ),
          );
        }
      }
    }
  }

  private declarationLocation(node: ts.Declaration): spec.SourceLocation {
    const file = node.getSourceFile();
    const line = ts.getLineAndCharacterOfPosition(file, node.getStart()).line;
    const filename = path.normalize(path.relative(this.projectInfo.projectRoot, file.fileName)).replace(/\\/g, '/');
    return {
      filename,
      line: line + 1,
    };
  }

  private _processBaseInterfaces(fqn: string, baseTypes?: ts.Type[]) {
    const erasedBases = new Array<ts.Type>();
    if (!baseTypes) {
      return { erasedBases };
    }

    const result = new Array<spec.NamedTypeReference>();
    const baseInterfaces = new Set<ts.Type>();

    const processBaseTypes = (types: ts.Type[]) => {
      for (const iface of types) {
        // base is private/internal, so we continue recursively with it's own bases
        if (
          this._isPrivateOrInternal(iface.symbol) ||
          isInternalSymbol(iface.symbol) ||
          this._isUnexportedLocalType(iface.symbol)
        ) {
          erasedBases.push(iface);
          if (!isInternalSymbol(iface.symbol)) {
            const bases = iface.getBaseTypes();
            if (bases) {
              processBaseTypes(bases);
            }
          }
          continue;
        }

        baseInterfaces.add(iface);
      }
    };

    processBaseTypes(baseTypes);

    const typeRefs = Array.from(baseInterfaces).map((iface) => {
      const decl = iface.symbol.valueDeclaration;
      const typeRef = this._typeReference(iface, decl, 'base interface');
      return { decl, typeRef };
    });
    for (const { decl, typeRef } of typeRefs) {
      if (!spec.isNamedTypeReference(typeRef)) {
        this._diagnostics.push(JsiiDiagnostic.JSII_3005_TYPE_USED_AS_INTERFACE.create(decl, typeRef));
        continue;
      }

      this._deferUntilTypesAvailable(fqn, [typeRef], decl, (deref) => {
        if (!spec.isInterfaceType(deref)) {
          this._diagnostics.push(JsiiDiagnostic.JSII_3005_TYPE_USED_AS_INTERFACE.create(decl, typeRef));
        }
      });

      result.push(typeRef);
    }

    return {
      interfaces: result.length === 0 ? undefined : result,
      erasedBases,
    };
  }

  // eslint-disable-next-line complexity
  private _visitClass(type: ts.Type, ctx: EmitContext): spec.ClassType | undefined {
    if (LOG.isTraceEnabled()) {
      LOG.trace(`Processing class: ${chalk.gray(ctx.namespace.join('.'))}.${chalk.cyan(type.symbol.name)}`);
    }

    if (_hasInternalJsDocTag(type.symbol)) {
      return undefined;
    }

    this._warnAboutReservedWords(type.symbol);

    const fqn = `${[this.projectInfo.name, ...ctx.namespace].join('.')}.${type.symbol.name}`;

    if (Case.pascal(type.symbol.name) !== type.symbol.name) {
      this._diagnostics.push(
        JsiiDiagnostic.JSII_8000_PASCAL_CASED_TYPE_NAMES.create(
          (type.symbol.valueDeclaration as ts.ClassDeclaration).name ??
            type.symbol.valueDeclaration ??
            type.symbol.declarations?.[0],
          type.symbol.name,
        ),
      );
    }

    const classDeclaration = type.symbol.valueDeclaration as ts.ClassDeclaration;
    for (const typeParam of classDeclaration.typeParameters ?? []) {
      this._diagnostics.push(JsiiDiagnostic.JSII_1006_GENERIC_TYPE.create(typeParam));
    }

    const jsiiType: spec.ClassType = bindings.setClassRelatedNode(
      {
        assembly: this.projectInfo.name,
        fqn,
        kind: spec.TypeKind.Class,
        name: type.symbol.name,
        namespace: ctx.namespace.length > 0 ? ctx.namespace.join('.') : undefined,
        docs: this._visitDocumentation(type.symbol, ctx).docs,
      },
      classDeclaration,
    );

    if (_isAbstract(type.symbol, jsiiType)) {
      jsiiType.abstract = true;
    }

    const erasedBases = new Array<ts.BaseType>();
    for (let base of type.getBaseTypes() ?? []) {
      if (jsiiType.base) {
        // Ignoring this - there has already been a compilation error generated by tsc here.
        continue;
      }

      //
      // base classes ("extends foo")

      // Crawl up the inheritance tree if the current base type is not exported, so we identify the type(s) to be
      // erased, and identify the closest exported base class, should there be one.
      while (base?.symbol && (this._isPrivateOrInternal(base.symbol) || this._isUnexportedLocalType(base.symbol))) {
        LOG.debug(
          `Base class of ${chalk.green(jsiiType.fqn)} named ${chalk.green(
            base.symbol.name,
          )} is not exported, erasing it...`,
        );
        erasedBases.push(base);
        base = (base.getBaseTypes() ?? [])[0];
      }
      if (base && !base.symbol) {
        const extendsClause = classDeclaration.heritageClauses?.find(
          (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
        );
        if (extendsClause) {
          this._diagnostics.push(
            JsiiDiagnostic.JSII_3004_INVALID_SUPERTYPE.create(extendsClause.types[0], extendsClause),
          );
        }
        continue;
      }
      if (!base || isInternalSymbol(base.symbol)) {
        // There is no exported base class to be found, pretend this class has no base class.
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const ref = this._typeReference(
        base,
        type.symbol.valueDeclaration ?? type.symbol.declarations?.[0],
        'base class',
      );

      if (!spec.isNamedTypeReference(ref)) {
        this._diagnostics.push(
          JsiiDiagnostic.JSII_3006_TYPE_USED_AS_CLASS.create(
            base.symbol.valueDeclaration ?? base.symbol.declarations?.[0],
            ref,
          ),
        );
        continue;
      }
      this._deferUntilTypesAvailable(fqn, [ref], base.symbol.valueDeclaration, (deref) => {
        if (!spec.isClassType(deref)) {
          this._diagnostics.push(
            JsiiDiagnostic.JSII_3006_TYPE_USED_AS_CLASS.create(
              base.symbol.valueDeclaration ?? base.symbol.declarations?.[0],
              ref,
            ),
          );
        }
      });
      jsiiType.base = ref.fqn;
    }

    //
    // base interfaces ("implements foo")

    // collect all "implements" declarations from the current type and all
    // erased base types (because otherwise we lose them, see jsii#487)
    const implementsClauses = new Array<ts.HeritageClause>();
    for (const heritage of [type, ...erasedBases].map(
      (t) => (t.symbol.valueDeclaration as ts.ClassDeclaration).heritageClauses ?? [],
    )) {
      for (const clause of heritage) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
          // Handled by `getBaseTypes`
          continue;
        } else if (clause.token !== ts.SyntaxKind.ImplementsKeyword) {
          this._diagnostics.push(
            JsiiDiagnostic.JSII_9998_UNSUPPORTED_NODE.create(
              clause,
              `Ignoring ${ts.SyntaxKind[clause.token]} heritage clause`,
            ),
          );
          continue;
        }

        implementsClauses.push(clause);
      }
    }

    // process all "implements" clauses
    const allInterfaces = new Set<string>();
    const baseInterfaces = implementsClauses.map((clause) =>
      this._processBaseInterfaces(
        fqn,
        clause.types.map((t) => this._getTypeFromTypeNode(t)),
      ),
    );
    for (const { interfaces } of baseInterfaces) {
      for (const ifc of interfaces ?? []) {
        allInterfaces.add(ifc.fqn);
      }
      if (interfaces) {
        this._deferUntilTypesAvailable(jsiiType.fqn, interfaces, type.symbol.valueDeclaration, (...ifaces) => {
          for (const iface of ifaces) {
            if (spec.isInterfaceType(iface) && iface.datatype) {
              this._diagnostics.push(
                JsiiDiagnostic.JSII_3007_ILLEGAL_STRUCT_EXTENSION.create(
                  type.symbol.valueDeclaration ?? type.symbol.declarations?.[0],
                  jsiiType,
                  iface,
                ),
              );
            }
          }
        });
      }
    }

    if (allInterfaces.size > 0) {
      jsiiType.interfaces = Array.from(allInterfaces);
    }

    if (!type.isClass()) {
      throw new Error('Oh no');
    }

    const allDeclarations: Array<{
      decl: ts.Declaration;
      type: ts.InterfaceType | ts.BaseType;
    }> = (type.symbol.declarations ?? []).map((decl) => ({ decl, type }));

    // Considering erased bases' declarations, too, so they are "blended in"
    for (const base of erasedBases) {
      allDeclarations.push(
        ...(base.symbol.declarations ?? []).map((decl) => ({
          decl,
          type: base,
        })),
      );
    }

    for (const { decl, type: declaringType } of allDeclarations) {
      const classDecl = decl as ts.ClassDeclaration | ts.InterfaceDeclaration;
      if (!classDecl.members) {
        continue;
      }

      for (const memberDecl of classDecl.members) {
        if (ts.isSemicolonClassElement(memberDecl)) {
          this._diagnostics.push(JsiiDiagnostic.JSII_9996_UNNECESSARY_TOKEN.create(memberDecl));
          continue;
        }

        const member = ts.isConstructorDeclaration(memberDecl)
          ? getConstructor(this._typeChecker.getTypeAtLocation(memberDecl.parent))
          : ts.isIndexSignatureDeclaration(memberDecl)
          ? type.symbol.members?.get(ts.InternalSymbolName.Index) ??
            type.symbol.exports?.get(ts.InternalSymbolName.Index)
          : this._typeChecker.getSymbolAtLocation(ts.getNameOfDeclaration(memberDecl) ?? memberDecl);

        if (member && this._isPrivateOrInternal(member, memberDecl as ts.ClassElement)) {
          continue;
        }

        if (ts.isIndexSignatureDeclaration(memberDecl)) {
          // Index signatures (static or not) are not supported in the jsii type model.
          this._diagnostics.push(
            JsiiDiagnostic.JSII_1999_UNSUPPORTED.create(memberDecl, {
              what: 'Index signatures',
              suggestInternal: true,
            }),
          );
          continue;
        }

        if (!(declaringType.symbol.getDeclarations() ?? []).find((d) => d === memberDecl.parent)) {
          continue;
        }

        // constructors are handled later
        if (ts.isConstructorDeclaration(memberDecl)) {
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        if (ts.isMethodDeclaration(memberDecl) || ts.isMethodSignature(memberDecl)) {
          // eslint-disable-next-line no-await-in-loop
          this._visitMethod(member!, jsiiType, ctx.replaceStability(jsiiType.docs?.stability), classDecl);
        } else if (
          ts.isPropertyDeclaration(memberDecl) ||
          ts.isPropertySignature(memberDecl) ||
          ts.isAccessor(memberDecl)
        ) {
          // eslint-disable-next-line no-await-in-loop
          this._visitProperty(member!, jsiiType, ctx.replaceStability(jsiiType.docs?.stability), classDecl);
        } else {
          this._diagnostics.push(
            JsiiDiagnostic.JSII_9998_UNSUPPORTED_NODE.create(
              ts.getNameOfDeclaration(memberDecl) ?? memberDecl,
              memberDecl.kind,
            ),
          );
        }
        /* eslint-enable no-await-in-loop */
      }
    }

    const memberEmitContext = ctx.replaceStability(jsiiType.docs && jsiiType.docs.stability);

    // Find the first defined constructor in this class, or it's erased bases
    const constructor = [type, ...erasedBases].map(getConstructor).find((ctor) => ctor != null);
    const ctorDeclaration = constructor && (constructor.declarations?.[0] as ts.ConstructorDeclaration | undefined);
    if (constructor && ctorDeclaration) {
      const signature = this._typeChecker.getSignatureFromDeclaration(ctorDeclaration);

      if ((ts.getCombinedModifierFlags(ctorDeclaration) & ts.ModifierFlags.Private) === 0) {
        jsiiType.initializer = {
          locationInModule: this.declarationLocation(ctorDeclaration),
        };
        if (signature) {
          for (const param of signature.getParameters()) {
            jsiiType.initializer.parameters = jsiiType.initializer.parameters ?? [];

            const jsiiParam = // eslint-disable-next-line no-await-in-loop
              this._toParameter(param, ctx.replaceStability(jsiiType.docs?.stability));

            if (containsIntersection(jsiiParam.type)) {
              this._diagnostics.push(JsiiDiagnostic.JSII_1010_INTERSECTION_NOT_IN_CTOR.create(param.declarations?.[0]));
            }

            jsiiType.initializer.parameters.push(jsiiParam);
            jsiiType.initializer.variadic = jsiiType.initializer?.parameters?.some((p) => !!p.variadic) || undefined;
            jsiiType.initializer.protected =
              (ts.getCombinedModifierFlags(ctorDeclaration) & ts.ModifierFlags.Protected) !== 0 || undefined;
          }
        }
        this._verifyConsecutiveOptionals(ctorDeclaration, jsiiType.initializer.parameters);
        jsiiType.initializer.docs = this._visitDocumentation(constructor, memberEmitContext).docs;
      }

      // Process constructor-based property declarations even if constructor is private
      if (signature) {
        for (const param of signature.getParameters()) {
          const decl = param.valueDeclaration ?? param.declarations?.[0];

          if (decl && ts.isParameterPropertyDeclaration(decl, decl.parent) && !this._isPrivateOrInternal(param)) {
            // eslint-disable-next-line no-await-in-loop
            this._visitProperty(param, jsiiType, memberEmitContext, ctorDeclaration.parent);
          }
        }
      }
    } else if (jsiiType.base) {
      this._deferUntilTypesAvailable(fqn, [jsiiType.base], type.symbol.valueDeclaration, (baseType) => {
        if (spec.isClassType(baseType)) {
          jsiiType.initializer = baseType.initializer;
        } else {
          this._diagnostics.push(
            JsiiDiagnostic.JSII_3999_INCOHERENT_TYPE_MODEL.create(
              type.symbol.valueDeclaration ?? type.symbol.declarations?.[0],
              `Base type of ${jsiiType.fqn} (${jsiiType.base}) is not a class`,
            ),
          );
        }
      });
    } else {
      jsiiType.initializer = {
        docs: ctx.stability && { stability: ctx.stability },
      };
    }

    this._verifyNoStaticMixing(jsiiType, type.symbol.valueDeclaration ?? type.symbol.declarations?.[0]);

    return _sortMembers(jsiiType);
  }

  /**
   * Use the TypeChecker's getTypeFromTypeNode, but throw a descriptive error if it fails
   */
  private _getTypeFromTypeNode(t: ts.TypeNode) {
    const type = this._typeChecker.getTypeFromTypeNode(t);
    if (isErrorType(type)) {
      throw new JsiiError(
        `Unable to resolve type: ${t.getFullText()}. This typically happens if something is wrong with your dependency closure.`,
      );
    }
    return type;
  }

  /**
   * Check that this class doesn't declare any members that are of different staticness in itself or any of its bases
   */
  private _verifyNoStaticMixing(klass: spec.ClassType, decl: ts.Declaration | undefined) {
    // Check class itself--may have two methods/props with the same name, so check the arrays
    const statics = new Set(
      (klass.methods ?? [])
        .concat(klass.properties ?? [])
        .filter((x) => x.static)
        .map((x) => x.name),
    );
    const nonStatics = new Set(
      (klass.methods ?? [])
        .concat(klass.properties ?? [])
        .filter((x) => !x.static)
        .map((x) => x.name),
    );
    // Intersect
    for (const member of Sets.intersect(statics, nonStatics)) {
      this._diagnostics.push(JsiiDiagnostic.JSII_5013_STATIC_INSTANCE_CONFLICT.create(decl, member, klass));
    }

    // Check against base classes. They will not contain duplicate member names so we can load
    // the members into a map.
    const classMembers = typeMembers(klass);
    this._withBaseClass(klass, decl, (base, recurse) => {
      for (const [name, baseMember] of Object.entries(typeMembers(base))) {
        const member = classMembers[name];
        if (!member) {
          continue;
        }

        if (!!baseMember.static !== !!member.static) {
          this._diagnostics.push(
            JsiiDiagnostic.JSII_5014_INHERITED_STATIC_CONFLICT.create(decl, member, klass, baseMember, base),
          );
        }
      }

      recurse();
    });
  }

  /**
   * Wrapper around _deferUntilTypesAvailable, invoke the callback with the given classes' base type
   *
   * Does nothing if the given class doesn't have a base class.
   *
   * The second argument will be a `recurse` function for easy recursion up the inheritance tree
   * (no messing around with binding 'self' and 'this' and doing multiple calls to _withBaseClass.)
   */
  private _withBaseClass(
    klass: spec.ClassType,
    decl: ts.Declaration | undefined,
    cb: (base: spec.ClassType, recurse: () => void) => void,
  ) {
    if (klass.base) {
      this._deferUntilTypesAvailable(klass.fqn, [klass.base], decl, (base) => {
        if (!spec.isClassType(base)) {
          throw new Error('Oh no');
        }
        cb(base, () => this._withBaseClass(base, decl, cb));
      });
    }
  }

  /**
   * Whether a symbol is marked with the `@jsii ignore` directive on *all* of its
   * declarations. We require every declaration to be ignored so that emission
   * (`_visitNode`) and reference resolution (`_isPrivateOrInternal`) agree: a
   * partially-ignored merged declaration stays a visible part of the public API.
   */
  private _isIgnored(symbol: ts.Symbol): boolean {
    return (
      (symbol.declarations?.length ?? 0) > 0 &&
      symbol.declarations!.every((decl) => Directives.of(decl, (diag) => this._diagnostics.push(diag)).ignore != null)
    );
  }

  /**
   * Collects the symbols exported from the entry point, following re-exports into submodules and namespaces.
   */
  private _collectEntryPointExports(entryPoint: ts.Symbol): Set<ts.Symbol> {
    const result = new Set<ts.Symbol>();
    const visit = (moduleSymbol: ts.Symbol) => {
      for (const exported of this._typeChecker.getExportsOfModule(moduleSymbol)) {
        const target =
          (exported.flags & ts.SymbolFlags.Alias) !== 0 ? this._typeChecker.getAliasedSymbol(exported) : exported;
        if (result.has(target)) {
          continue;
        }
        result.add(target);
        if ((target.flags & ts.SymbolFlags.Module) !== 0) {
          visit(target);
        }
      }
    };
    visit(entryPoint);
    return result;
  }

  /**
   * Whether a type is declared in this package's sources but is not reachable from the entry point. Such a type is
   * hidden from jsii consumers just like a type declared without `export`, which it must have to be imported from
   * another file.
   */
  private _isUnexportedLocalType(symbol: ts.Symbol): boolean {
    if (this._entryPointExports == null || this._entryPointExports.has(symbol)) {
      return false;
    }
    const declarations = symbol.declarations ?? [];
    return (
      declarations.length > 0 &&
      declarations.every((decl) => {
        const sourceFile = decl.getSourceFile();
        return !sourceFile.isDeclarationFile && !this.program.isSourceFileFromExternalLibrary(sourceFile);
      })
    );
  }

  /**
   * @returns true if this member is internal and should be omitted from the type manifest
   */
  private _isPrivateOrInternal(symbol: ts.Symbol, validateDeclaration?: ts.Declaration): boolean {
    const hasInternalJsDocTag = _hasInternalJsDocTag(symbol);
    const hasInternalSymbolName = isInternalSymbol(symbol);
    const hasUnderscorePrefix = !hasInternalSymbolName && symbol.name.startsWith('_');

    if (_isPrivate(symbol)) {
      LOG.trace(`${chalk.cyan(symbol.name)} is marked "private", or is an unexported type declaration`);
      return true;
    }

    // If all the declarations are marked with `@jsii ignore`, then this is effetcively private as far as jsii is concerned.
    if (this._isIgnored(symbol)) {
      return true;
    }

    if (!hasInternalJsDocTag && !hasUnderscorePrefix) {
      return false;
    }

    // We only validate if we have a declaration and the symbol doesn't have an internal name.
    if (validateDeclaration && !hasInternalSymbolName) {
      if (!hasUnderscorePrefix) {
        this._diagnostics.push(
          JsiiDiagnostic.JSII_8005_INTERNAL_UNDERSCORE.create(
            ts.getNameOfDeclaration(validateDeclaration) ?? validateDeclaration,
            symbol.name,
          ),
        );
      }

      if (!hasInternalJsDocTag) {
        this._diagnostics.push(
          JsiiDiagnostic.JSII_8006_UNDERSCORE_INTERNAL.create(
            ts.getNameOfDeclaration(validateDeclaration) ?? validateDeclaration,
            symbol.name,
          ),
        );
      }
    }

    return true;
  }

  private _visitEnum(type: ts.Type, ctx: EmitContext): spec.EnumType | undefined {
    if (LOG.isTraceEnabled()) {
      LOG.trace(`Processing enum: ${chalk.gray(ctx.namespace.join('.'))}.${chalk.cyan(type.symbol.name)}`);
    }

    // Forcefully resolving to the EnumDeclaration symbol for single-valued enums
    let decl: ts.Node | undefined = type.symbol.declarations?.[0];
    let symbol: ts.Symbol | undefined;
    if (decl && ts.isEnumMember(decl)) {
      decl = decl?.parent;
    }
    if (decl && ts.isEnumDeclaration(decl)) {
      symbol = getSymbolFromDeclaration(decl, this._typeChecker);
    }
    if (!decl || !symbol || !ts.isEnumDeclaration(decl)) {
      throw new JsiiError(`Unable to resolve enum declaration for ${type.symbol.name}!`);
    }

    if (_hasInternalJsDocTag(symbol)) {
      return undefined;
    }

    // check the enum to see if there are duplicate enum values
    this.assertNoDuplicateEnumValues(decl);

    this._warnAboutReservedWords(symbol);

    const flags = ts.getCombinedModifierFlags(decl);
    if (flags & ts.ModifierFlags.Const) {
      this._diagnostics.push(
        JsiiDiagnostic.JSII_1000_NO_CONST_ENUM.create(
          decl.modifiers?.find((mod) => mod.kind === ts.SyntaxKind.ConstKeyword) ?? decl,
        ),
      );
    }

    for (const memberDecl of decl.members) {
      if (this._typeChecker.getConstantValue(memberDecl) === undefined) {
        this._diagnostics.push(JsiiDiagnostic.JSII_1012_ONLY_CONST_ENUM_MEMBERS.create(memberDecl));
      }
    }

    const { docs } = this._visitDocumentation(symbol, ctx);

    const typeContext = ctx.replaceStability(docs?.stability);
    const members = type.isUnion() ? type.types : [type];

    if (Case.pascal(symbol.name) !== symbol.name) {
      this._diagnostics.push(
        JsiiDiagnostic.JSII_8000_PASCAL_CASED_TYPE_NAMES.create(
          (symbol.valueDeclaration as ts.EnumDeclaration).name,
          symbol.name,
        ),
      );
    }

    const jsiiType: spec.EnumType = bindings.setEnumRelatedNode(
      {
        assembly: this.projectInfo.name,
        fqn: `${[this.projectInfo.name, ...ctx.namespace].join('.')}.${symbol.name}`,
        kind: spec.TypeKind.Enum,
        members: members.map((m) => {
          // eslint-disable-next-line @typescript-eslint/no-shadow
          const { docs } = this._visitDocumentation(m.symbol, typeContext);
          return { name: m.symbol.name, docs };
        }),
        name: symbol.name,
        namespace: ctx.namespace.length > 0 ? ctx.namespace.join('.') : undefined,
        docs,

        // Set SymbolId here instead of later, as by default TS will pick single-enum members
        // as the target symbol if possible.
        symbolId: symbolIdentifier(this._typeChecker, symbol),
      },
      decl,
    );

    this._typeTracker.registerEnum(jsiiType.fqn, decl);

    return jsiiType;
  }

  private assertNoDuplicateEnumValues(decl: ts.EnumDeclaration): void {
    type EnumValue = {
      name: string;
      value: string;
      decl: ts.DeclarationName | undefined;
    };

    const enumValues = decl.members
      .filter((m) => m.initializer)
      .map((member): EnumValue => {
        return {
          value: member.initializer!.getText(),
          name: member.name.getText(),
          decl: ts.getNameOfDeclaration(member),
        };
      });

    const hasDuplicateEnumValues = enumValues.some(
      (val, _, arr) => arr.filter((e) => val.value === e.value).length > 1,
    );

    if (hasDuplicateEnumValues) {
      const enumValueMap = enumValues.reduce<Record<string, EnumValue[]>>((acc, val) => {
        if (!acc[val.value]) {
          acc[val.value] = [];
        }
        acc[val.value].push(val);
        return acc;
      }, {});
      for (const duplicateValue of Object.keys(enumValueMap)) {
        if (enumValueMap[duplicateValue].length > 1) {
          const err = JsiiDiagnostic.JSII_1004_DUPLICATE_ENUM_VALUE.create(
            enumValueMap[duplicateValue][0].decl!,
            duplicateValue,
            enumValueMap[duplicateValue].map((v) => v.name),
          );
          for (let i = 1; i < enumValueMap[duplicateValue].length; i++) {
            err.addRelatedInformation(enumValueMap[duplicateValue][i].decl!, 'The conflicting declaration is here');
          }
          this._diagnostics.push(err);
        }
      }
    }
  }

  /**
   * Return docs for a symbol
   */
  private _visitDocumentation(
    sym: ts.Symbol,
    context: EmitContext,
  ): { readonly docs?: spec.Docs; readonly hints: TypeSystemHints } {
    const result = parseSymbolDocumentation(sym, this._typeChecker);

    for (const diag of result.diagnostics ?? []) {
      this._diagnostics.push(
        JsiiDiagnostic.JSII_7999_DOCUMENTATION_ERROR.create(sym.valueDeclaration ?? sym.declarations?.[0], diag),
      );
    }

    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    // The @struct hint is only valid for interface declarations
    if (decl && !ts.isInterfaceDeclaration(decl) && result.hints.struct) {
      this._diagnostics.push(
        JsiiDiagnostic.JSII_7001_ILLEGAL_HINT.create(
          _findHint(decl, 'struct')!,
          'struct',
          'interfaces with only readonly properties',
        ).addRelatedInformationIf(ts.getNameOfDeclaration(decl) ?? decl, 'The annotated declaration is here'),
      );
      // Clean up the bad hint...
      delete (result.hints as any).struct;
    }

    // Apply the current context's stability if none was specified locally.
    if (result.docs.stability == null) {
      result.docs.stability = context.stability;
    }

    const allUndefined = Object.values(result.docs).every((v) => v === undefined);
    return {
      docs: !allUndefined ? result.docs : undefined,
      hints: result.hints,
    };
  }

  /**
   * Check that all parameters the doc block refers to with a @param declaration actually exist
   */
  private _validateReferencedDocParams(method: spec.Method, methodSym: ts.Symbol) {
    const params = getReferencedDocParams(methodSym);
    const actualNames = new Set((method.parameters ?? []).map((p) => p.name));
    for (const param of params) {
      if (!actualNames.has(param)) {
        this._diagnostics.push(
          JsiiDiagnostic.JSII_7000_NON_EXISTENT_PARAMETER.create(
            methodSym.valueDeclaration ?? methodSym.declarations?.[0],
            method,
            param,
          ),
        );
      }
    }
  }

  private _visitInterface(type: ts.Type, ctx: EmitContext): spec.InterfaceType | undefined {
    if (LOG.isTraceEnabled()) {
      LOG.trace(`Processing interface: ${chalk.gray(ctx.namespace.join('.'))}.${chalk.cyan(type.symbol.name)}`);
    }

    if (_hasInternalJsDocTag(type.symbol)) {
      return undefined;
    }

    this._warnAboutReservedWords(type.symbol);

    const fqn = `${[this.projectInfo.name, ...ctx.namespace].join('.')}.${type.symbol.name}`;

    const { docs, hints } = this._visitDocumentation(type.symbol, ctx);
    const jsiiType: spec.InterfaceType = bindings.setInterfaceRelatedNode(
      {
        assembly: this.projectInfo.name,
        fqn,
        kind: spec.TypeKind.Interface,
        name: type.symbol.name,
        namespace: ctx.namespace.length > 0 ? ctx.namespace.join('.') : undefined,
        docs,
      },
      type.symbol.declarations?.[0] as ts.InterfaceDeclaration | undefined,
    );

    const { interfaces, erasedBases } = this._processBaseInterfaces(fqn, type.getBaseTypes());
    jsiiType.interfaces = apply(interfaces, (arr) => arr.map((i) => i.fqn));

    const typeDecl = (type.symbol.valueDeclaration ?? type.symbol.declarations?.[0]) as
      | ts.ClassLikeDeclaration
      | ts.InterfaceDeclaration
      | undefined;

    for (const typeParam of typeDecl?.typeParameters ?? []) {
      this._diagnostics.push(JsiiDiagnostic.JSII_1006_GENERIC_TYPE.create(typeParam));
    }

    for (const decl of (typeDecl?.members as ReadonlyArray<ts.ClassElement | ts.TypeElement> | undefined)?.filter(
      (mem) => ts.isIndexSignatureDeclaration(mem),
    ) ?? []) {
      const sym =
        type.symbol.members?.get(ts.InternalSymbolName.Index) ?? type.symbol.exports?.get(ts.InternalSymbolName.Index);
      if (sym != null && this._isPrivateOrInternal(sym, decl)) {
        continue;
      }

      // Index signatures (static or not) are not supported in the jsii type model.
      this._diagnostics.push(
        JsiiDiagnostic.JSII_1999_UNSUPPORTED.create(decl, { what: 'Index signatures', suggestInternal: true }),
      );
    }

    for (const declaringType of [type, ...erasedBases]) {
      for (const member of declaringType.getProperties()) {
        const decl = member.valueDeclaration ?? (member.declarations?.[0] as ts.PropertyDeclaration | undefined);

        if (!(declaringType.symbol.getDeclarations() ?? []).find((d) => d === decl?.parent)) {
          continue;
        }

        if (this._isPrivateOrInternal(member, decl)) {
          continue;
        }

        if (decl && (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl))) {
          // eslint-disable-next-line no-await-in-loop
          this._visitMethod(member, jsiiType, ctx.replaceStability(jsiiType.docs?.stability), typeDecl);
        } else if (decl && (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl) || ts.isAccessor(decl))) {
          // eslint-disable-next-line no-await-in-loop
          this._visitProperty(member, jsiiType, ctx.replaceStability(jsiiType.docs?.stability), typeDecl);
        } else {
          this._diagnostics.push(
            JsiiDiagnostic.JSII_9998_UNSUPPORTED_NODE.create(
              _nameOrDeclarationNode(member),
              (member.valueDeclaration ?? member.declarations?.[0])?.kind ?? ts.SyntaxKind.Unknown,
            ),
          );
        }
      }
    }

    // Calculate datatype based on the datatypeness of this interface and all of its parents
    // To keep the spec minimal the actual values of the attribute are "true" or "undefined" (to represent "false").
    const declaration = type.symbol.valueDeclaration ?? type.symbol.declarations?.[0];
    this._deferUntilTypesAvailable(fqn, jsiiType.interfaces ?? [], declaration, (...bases: spec.Type[]) => {
      if ((jsiiType.methods ?? []).length === 0) {
        jsiiType.datatype = true;
      } else if (hints.struct) {
        this._diagnostics.push(
          jsiiType.methods!.reduce((diag, mthod) => {
            const node = bindings.getMethodRelatedNode(mthod);
            return node
              ? diag.addRelatedInformation(ts.getNameOfDeclaration(node) ?? node, 'A method is declared here')
              : diag;
          }, JsiiDiagnostic.JSII_7001_ILLEGAL_HINT.create(declaration && _findHint(declaration, 'struct')!, 'struct', 'interfaces with only readonly properties').addRelatedInformationIf(ts.getNameOfDeclaration(declaration) ?? declaration, 'The annotated declartion is here')),
        );
      }

      for (const base of bases) {
        if (spec.isInterfaceType(base) && !base.datatype) {
          jsiiType.datatype = undefined;
        }
      }

      const interfaceName = isInterfaceName(jsiiType.name);

      // If it's not a datatype the name must start with an "I".
      if (!jsiiType.datatype && !interfaceName) {
        this._diagnostics.push(
          JsiiDiagnostic.JSII_8007_BEHAVIORAL_INTERFACE_NAME.create(
            ts.getNameOfDeclaration(declaration) ?? declaration,
            jsiiType.name,
          ),
        );
      }

      // NOTE: We need to be careful with the `I` prefix for behavioral interfaces, as this can mess with PascalCase
      // transformations, especially with short names such as `IA`, ...
      const expectedName = interfaceName ? `I${Case.pascal(type.symbol.name.slice(1))}` : Case.pascal(type.symbol.name);
      if (expectedName !== type.symbol.name) {
        this._diagnostics.push(
          JsiiDiagnostic.JSII_8000_PASCAL_CASED_TYPE_NAMES.create(
            (type.symbol.declarations?.[0] as ts.InterfaceDeclaration | undefined)?.name,
            type.symbol.name,
            expectedName,
          ),
        );
      }

      // If the name starts with an "I" it is not intended as a datatype, so switch that off,
      // unless a TSDoc hint was set to force this to be considered a behavioral interface.
      if (jsiiType.datatype && interfaceName && !hints.struct) {
        delete jsiiType.datatype;
      }

      // Okay, this is a data type, check that all properties are readonly
      if (jsiiType.datatype) {
        for (const prop of jsiiType.properties ?? []) {
          if (!prop.immutable) {
            const p = type.getProperty(prop.name)!;
            this._diagnostics.push(
              JsiiDiagnostic.JSII_3008_STRUCT_PROPS_MUST_BE_READONLY.create(
                _nameOrDeclarationNode(p),
                p.name,
                jsiiType,
              ),
            );

            // force property to be "readonly" since jsii languages will pass this by-value
            prop.immutable = true;
          }
        }
      } else {
        // This is *NOT* a data type, so it may not extend something that is one.
        for (const base of bases) {
          if (!spec.isInterfaceType(base)) {
            // Invalid type we already warned about earlier, just ignoring it here..
            continue;
          }
          if (base.datatype) {
            this._diagnostics.push(
              JsiiDiagnostic.JSII_3007_ILLEGAL_STRUCT_EXTENSION.create(
                type.symbol.valueDeclaration ?? type.symbol.declarations?.[0],
                jsiiType,
                base,
              ),
            );
          }
        }
      }
    });

    // Check that any member an interface re-declares from a base type keeps
    // the exact same shape. Re-declaring is useful to change documentation
    // (e.g. a different `@default`), but C# interfaces cannot narrow a member's
    // type (no covariance), so anything else is rejected.
    const members = typeMembers(jsiiType);
    const checkNoIntersection = (...bases: spec.Type[]) => {
      for (const base of bases) {
        if (!spec.isInterfaceType(base)) {
          continue;
        }

        const baseMembers = typeMembers(base);
        for (const [memberName, member] of Object.entries(members)) {
          const baseMember = baseMembers[memberName];
          if (memberName === '' || baseMember == null) {
            continue;
          }
          if (isIdenticalRedeclaration(member, baseMember)) {
            // Bases are visited nearest-first, so the closest one wins.
            member.overrides ??= base.fqn;
            this.usedFeatures.add('interface-member-doc-overrides');
            continue;
          }
          this._diagnostics.push(
            JsiiDiagnostic.JSII_5015_REDECLARED_INTERFACE_MEMBER.create(
              type.symbol.valueDeclaration ?? type.symbol.declarations?.[0],
              memberName,
              jsiiType,
            ),
          );
        }
        // Recurse upwards
        this._deferUntilTypesAvailable(fqn, base.interfaces ?? [], type.symbol.valueDeclaration, checkNoIntersection);
      }
    };
    this._deferUntilTypesAvailable(fqn, jsiiType.interfaces ?? [], type.symbol.valueDeclaration, checkNoIntersection);

    return _sortMembers(jsiiType);
  }

  private _visitMethod(
    symbol: ts.Symbol,
    type: spec.ClassType | spec.InterfaceType,
    ctx: EmitContext,
    declaringTypeDecl: ts.ClassLikeDeclaration | ts.InterfaceDeclaration | undefined,
  ) {
    if (LOG.isTraceEnabled()) {
      LOG.trace(`Processing method: ${chalk.green(type.fqn)}#${chalk.cyan(symbol.name)}`);
    }

    const declaration = symbol.valueDeclaration as ts.MethodDeclaration | ts.MethodSignature;
    const signature = this._typeChecker.getSignatureFromDeclaration(declaration);
    if (!signature) {
      this._diagnostics.push(
        JsiiDiagnostic.JSII_9004_UNABLE_TO_COMPUTE_SIGNATURE.create(declaration, symbol.name, type),
      );
      return;
    }

    if (type.name === Case.pascal(symbol.name)) {
      this._diagnostics.push(
        JsiiDiagnostic.JSII_5019_MEMBER_TYPE_NAME_CONFLICT.create(
          declaration.name,
          'method',
          symbol,
          type,
        ).addRelatedInformationIf(
          declaringTypeDecl?.name ?? declaringTypeDecl,
          `The declaring ${type.kind} is introduced here`,
        ),
      );
    }

    if (isProhibitedMemberName(symbol.name)) {
      this._diagnostics.push(JsiiDiagnostic.JSII_5016_PROHIBITED_MEMBER_NAME.create(declaration.name, symbol.name));
      return;
    }
    this._warnAboutReservedWords(symbol);

    const parameters = signature.getParameters().map((p) => this._toParameter(p, ctx));
    const returnType = signature.getReturnType();
    const method: spec.Method = bindings.setMethodRelatedNode(
      {
        abstract: _isAbstract(symbol, type) || undefined,
        name: symbol.name,
        parameters: parameters.length > 0 ? parameters : undefined,
        protected: _isProtected(symbol) || undefined,
        returns: _isVoid(returnType)
          ? undefined
          : this._optionalValue(returnType, declaration.type ?? declaration.name, 'return type'),
        async: _isPromise(returnType) || undefined,
        static: _isStatic(symbol) || undefined,
        locationInModule: this.declarationLocation(declaration),
      },
      declaration,
    );
    method.variadic = method.parameters?.some((p) => !!p.variadic) === true ? true : undefined;

    this._verifyConsecutiveOptionals(declaration, method.parameters);

    method.docs = this._visitDocumentation(symbol, ctx).docs;

    // If the last parameter is a datatype, verify that it does not share any field names with
    // other function arguments, so that it can be turned into keyword arguments by jsii frontends
    // that support such.
    const lastParamTypeRef = apply(last(parameters), (x) => x.type);
    const lastParamSymbol = last(signature.getParameters());
    if (lastParamTypeRef && spec.isNamedTypeReference(lastParamTypeRef)) {
      this._deferUntilTypesAvailable(
        symbol.name,
        [lastParamTypeRef],
        lastParamSymbol!.declarations?.[0],
        (lastParamType) => {
          if (!spec.isInterfaceType(lastParamType) || !lastParamType.datatype) {
            return;
          }

          // Liftable datatype, make sure no parameter names match any of the properties in the datatype
          const propNames = this.allProperties(lastParamType);
          const paramNames = new Set(parameters.slice(0, parameters.length - 1).map((x) => x.name));
          const sharedNames = Sets.intersection(propNames, paramNames);

          for (const badName of sharedNames) {
            this._diagnostics.push(JsiiDiagnostic.JSII_5017_POSITIONAL_KEYWORD_CONFLICT.create(declaration, badName));
          }
        },
      );
    }

    this._validateReferencedDocParams(method, symbol);

    type.methods = type.methods ?? [];
    if (type.methods.find((m) => m.name === method.name && m.static === method.static) != null) {
      LOG.trace(`Dropping re-declaration of ${chalk.green(type.fqn)}#${chalk.cyan(method.name)}`);
      return;
    }
    type.methods.push(method);
  }

  private _warnAboutReservedWords(symbol: ts.Symbol) {
    const reservingLanguages = isReservedName(symbol.name);
    if (reservingLanguages) {
      this._diagnostics.push(
        JsiiDiagnostic.JSII_5018_RESERVED_WORD.create(_nameOrDeclarationNode(symbol), symbol.name, reservingLanguages),
      );
    }
  }

  private _visitProperty(
    symbol: ts.Symbol,
    type: spec.ClassType | spec.InterfaceType,
    ctx: EmitContext,
    declaringTypeDecl: ts.ClassLikeDeclaration | ts.InterfaceDeclaration | undefined,
  ) {
    if (type.properties?.find((p) => p.name === symbol.name)) {
      /*
       * Second declaration of the same property. For example, if code specifies a getter & setter signature,
       * there will be one pass for each of the signatures, but we can process only the first encountered. The
       * typescript compiler will take care of making sure we don't have conflicting declarations, anyway.
       */
      return;
    }

    if (LOG.isTraceEnabled()) {
      LOG.trace(`Processing property: ${chalk.green(type.fqn)}#${chalk.cyan(symbol.name)}`);
    }

    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    const signature = declaration as
      | ts.PropertySignature
      | ts.PropertyDeclaration
      | ts.AccessorDeclaration
      | ts.ParameterPropertyDeclaration;

    if (type.name === Case.pascal(symbol.name)) {
      this._diagnostics.push(
        JsiiDiagnostic.JSII_5019_MEMBER_TYPE_NAME_CONFLICT.create(
          signature.name,
          'property',
          symbol,
          type,
        ).addRelatedInformationIf(
          declaringTypeDecl?.name ?? declaringTypeDecl,
          `The declaring ${type.kind} is introduced here`,
        ),
      );
    }

    if (isProhibitedMemberName(symbol.name)) {
      this._diagnostics.push(
        JsiiDiagnostic.JSII_5016_PROHIBITED_MEMBER_NAME.create(
          symbol.valueDeclaration ?? symbol.declarations?.[0],
          symbol.name,
        ),
      );
      return;
    }

    this._warnAboutReservedWords(symbol);

    const property: spec.Property = bindings.setPropertyRelatedNode(
      {
        ...this._optionalValue(
          this._typeChecker.getTypeOfSymbolAtLocation(symbol, signature),
          signature.type ?? signature.name,
          'property type',
        ),
        abstract: _isAbstract(symbol, type) || undefined,
        name: symbol.name,
        protected: _isProtected(symbol) || undefined,
        static: _isStatic(symbol) || undefined,
        locationInModule: this.declarationLocation(signature),
      },
      signature,
    );

    if (ts.isGetAccessor(signature)) {
      property.immutable = true;
      for (const decl of symbol.getDeclarations() ?? []) {
        if (!ts.isSetAccessor(decl)) {
          continue;
        }
        delete property.immutable;

        // Verify the setter doesn't have a Separate Write Type (SWT)
        const valueParam = decl.parameters[0];
        if (valueParam?.type == null) {
          // If there is no type node, there can't be a SWT
          continue;
        }
        const paramType = this._typeChecker.getTypeFromTypeNode(valueParam.type);
        const paramOptionalValue = this._optionalValue(paramType, valueParam.type, 'parameter type');

        if (
          property.optional !== paramOptionalValue.optional ||
          describeTypeReference(property.type) !== describeTypeReference(paramOptionalValue.type)
        ) {
          this._diagnostics.push(
            JsiiDiagnostic.JSII_1005_SEPARATE_WRITE_TYPE.create(valueParam.type).addRelatedInformation(
              signature.type ?? signature.name,
              'The getter signature is declared here',
            ),
          );
        }
      }
    } else {
      property.immutable = (ts.getCombinedModifierFlags(signature) & ts.ModifierFlags.Readonly) !== 0 || undefined;
    }

    if (signature.questionToken) {
      property.optional = true;
    }

    if (property.static && property.immutable && ts.isPropertyDeclaration(signature) && signature.initializer) {
      property.const = true;
    }

    property.docs = this._visitDocumentation(symbol, ctx).docs;

    type.properties = type.properties ?? [];
    if (type.properties.find((prop) => prop.name === property.name && prop.static === property.static) != null) {
      LOG.trace(`Dropping re-declaration of ${chalk.green(type.fqn)}#${chalk.cyan(property.name)}`);
      return;
    }
    type.properties.push(property);
  }

  private _toParameter(paramSymbol: ts.Symbol, ctx: EmitContext): spec.Parameter {
    if (LOG.isTraceEnabled()) {
      LOG.trace(`Processing parameter: ${chalk.cyan(paramSymbol.name)}`);
    }
    const paramDeclaration = paramSymbol.valueDeclaration as ts.ParameterDeclaration;

    this._warnAboutReservedWords(paramSymbol);

    const parameter: spec.Parameter = bindings.setParameterRelatedNode(
      {
        ...this._optionalValue(
          this._typeChecker.getTypeAtLocation(paramDeclaration),
          paramDeclaration.type ?? paramDeclaration.name,
          'parameter type',
        ),
        name: paramSymbol.name,
        variadic: paramDeclaration.dotDotDotToken && true,
      },
      paramDeclaration,
    );

    if (parameter.variadic && spec.isCollectionTypeReference(parameter.type)) {
      // TypeScript types variadic parameters as an array, but JSII uses the item-type instead.
      parameter.type = parameter.type.collection.elementtype;
    } else if (paramDeclaration.initializer || paramDeclaration.questionToken) {
      // Optional parameters have an inherently null-able type.
      parameter.optional = true;
    }

    parameter.docs = this._visitDocumentation(
      paramSymbol,
      ctx.removeStability(), // No inheritance on purpose
    ).docs;

    // Don't rewrite doc comment here on purpose -- instead, we add them as '@param'
    // into the parent's doc comment.

    return parameter;
  }

  private _typeReference(type: ts.Type, declaration: ts.Node | undefined, purpose: TypeUseKind): spec.TypeReference {
    const optionalValue = this._optionalValue(type, declaration, purpose);
    if (optionalValue.optional) {
      this._diagnostics.push(
        JsiiDiagnostic.JSII_3999_INCOHERENT_TYPE_MODEL.create(
          declaration,
          'Encountered optional value in location where a plain type reference is expected',
        ),
      );
    }
    return optionalValue.type;
  }

  private _optionalValue(type: ts.Type, declaration: ts.Node | undefined, purpose: TypeUseKind): spec.OptionalValue {
    const isThisType = _isThisType(type, this._typeChecker, declaration?.parent);

    if (type.isLiteral() && _isEnumLike(type)) {
      type = this._typeChecker.getBaseTypeOfLiteralType(type);
    } else {
      type = this._typeChecker.getApparentType(type);
    }

    const primitiveType = _tryMakePrimitiveType.call(this);
    if (primitiveType) {
      return { type: primitiveType };
    }

    if (type.isUnion() && !_isEnumLike(type)) {
      return _setType.call(this, 'union');
    }

    if (type.isIntersection()) {
      this.usedFeatures.add('intersection-types');
      const ret = _setType.call(this, 'intersection');
      const intersectionType = ret.type as spec.IntersectionTypeReference;

      this.validateIntersectionType(intersectionType, declaration);

      return ret;
    }

    if ((type.getFlags() & ts.TypeFlags.Never) !== 0) {
      this._diagnostics.push(JsiiDiagnostic.JSII_1007_NEVER_TYPE.create(declaration));
      return { type: spec.CANONICAL_ANY };
    }

    if (!type.symbol) {
      this._diagnostics.push(JsiiDiagnostic.JSII_1001_TYPE_HAS_NO_SYMBOL.create(declaration));
      return { type: spec.CANONICAL_ANY };
    }

    // Built-in Array/ReadonlyArray (including `readonly T[]`), by type identity.
    if (type.symbol.name === 'Array' || this._typeChecker.isArrayType(type)) {
      return { type: _arrayType.call(this) };
    }

    if (type.symbol.name === '__type' && type.symbol.members) {
      return { type: _mapType.call(this) };
    }

    if (type.symbol.escapedName === 'Promise') {
      const typeRef = type as ts.TypeReference;
      if (!typeRef.typeArguments || typeRef.typeArguments.length !== 1) {
        this._diagnostics.push(JsiiDiagnostic.JSII_1002_UNSPECIFIED_PROMISE.create(declaration));
        return { type: spec.CANONICAL_ANY };
      }
      return {
        type: this._typeReference(typeRef.typeArguments[0], declaration, purpose),
      };
    }

    const fqn = this._getFQN(type, declaration, purpose, isThisType);
    if (fqn == null) {
      this._diagnostics.push(
        JsiiDiagnostic.JSII_9997_UNKNOWN_ERROR.create(declaration, new Error('Could not determine FQN')),
      );
      return { type: { fqn: '' } };
    }

    return {
      type: { fqn },
    };

    function _arrayType(this: Assembler): spec.CollectionTypeReference {
      const typeRef = type as ts.TypeReference;
      let elementtype: spec.TypeReference;

      if (typeRef.typeArguments?.length === 1) {
        elementtype = this._typeReference(typeRef.typeArguments[0], declaration, 'list element type');
      } else {
        const count = typeRef.typeArguments ? typeRef.typeArguments.length : 'none';
        this._diagnostics.push(
          JsiiDiagnostic.JSII_1003_UNSUPPORTED_TYPE.create(
            declaration,
            `Array references must have exactly one type argument (found ${count})`,
          ),
        );
        elementtype = spec.CANONICAL_ANY;
      }

      return {
        collection: {
          elementtype,
          kind: spec.CollectionKind.Array,
        },
      };
    }

    function _mapType(this: Assembler): spec.CollectionTypeReference {
      let elementtype: spec.TypeReference;
      const objectType = type.getStringIndexType();
      if (objectType) {
        elementtype = this._typeReference(objectType, declaration, 'map element type');
      } else {
        const typeDecl = type.symbol.declarations?.[0];
        if (
          typeDecl != null &&
          ts.isTypeLiteralNode(typeDecl) &&
          typeDecl.members.length == 1 &&
          ts.isIndexSignatureDeclaration(typeDecl.members[0]) &&
          typeDecl.members[0].parameters[0].type != null &&
          ts.isTemplateLiteralTypeNode(typeDecl.members[0].parameters[0].type)
        ) {
          const indexTypeNode = typeDecl.members[0].type;
          const indexType = this._typeChecker.getTypeFromTypeNode(indexTypeNode);
          elementtype = this._typeReference(indexType, indexTypeNode, 'map element type');
        } else {
          this._diagnostics.push(
            JsiiDiagnostic.JSII_1003_UNSUPPORTED_TYPE.create(
              declaration,
              'Only string-indexed map types are supported',
            ),
          );
          elementtype = spec.CANONICAL_ANY;
        }
      }
      return {
        collection: {
          elementtype,
          kind: spec.CollectionKind.Map,
        },
      };
    }

    function _tryMakePrimitiveType(this: Assembler): spec.PrimitiveTypeReference | undefined {
      if (!type.symbol) {
        if (type.flags & ts.TypeFlags.Object) {
          if (isTupleType(type as ts.ObjectType)) {
            this._diagnostics.push(
              JsiiDiagnostic.JSII_1999_UNSUPPORTED.create(declaration, { what: 'Tuple types', alternative: 'arrays' }),
            );
          }

          return { primitive: spec.PrimitiveType.Json };
        }
        if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
          return spec.CANONICAL_ANY;
        }
      } else if (
        type.symbol.valueDeclaration &&
        isUnder(type.symbol.valueDeclaration.getSourceFile().fileName, this.stdlib)
      ) {
        switch (type.symbol.name) {
          case 'Boolean':
            return { primitive: spec.PrimitiveType.Boolean };
          case 'Date':
            return { primitive: spec.PrimitiveType.Date };
          case 'Number':
            return { primitive: spec.PrimitiveType.Number };
          case 'String':
            return { primitive: spec.PrimitiveType.String };
        }
      }
      // Not a primitive type!
      return undefined;
    }

    function _setType(this: Assembler, field: 'union' | 'intersection'): spec.OptionalValue {
      const types = new Array<spec.TypeReference>();
      let optional: boolean | undefined;

      for (const subType of (type as ts.UnionType).types) {
        if (subType.flags & ts.TypeFlags.Undefined) {
          optional = true;
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const resolvedType = this._typeReference(subType, declaration, purpose);
        if (types.some((ref) => deepEqual(ref, resolvedType))) {
          continue;
        }
        types.push(resolvedType);
      }

      const returnedType: spec.UnionTypeReference | spec.IntersectionTypeReference = {
        [field]: { types },
      } as any;
      return types.length === 1 ? { optional, type: types[0] } : { optional, type: returnedType };
    }
  }

  /**
   * Validate the restrictions on an intersection type reference
   *
   * - Type only consists of (behavioral) interface types
   * - For all types referenced in the intersection, the definitions of all shared
   *   members must match exactly.
   */
  private validateIntersectionType(intersectionType: spec.IntersectionTypeReference, declaration: ts.Node | undefined) {
    // Validate that this intersection type only consists of interface types
    this._deferUntilTypesAvailable('', intersectionType.intersection.types, declaration, (...elementTypes) => {
      const requestedFqns = new Set(intersectionType.intersection.types.map(typeReferenceToString));
      const resolvedFqns = new Set(elementTypes.map((t) => t.fqn));

      const unresolved = Sets.diff(requestedFqns, resolvedFqns);
      if (unresolved.size > 0) {
        this._diagnostics.push(
          JsiiDiagnostic.JSII_1008_ONLY_INTERFACE_INTERSECTION.create(declaration, Array.from(unresolved).join(', ')),
        );
      }

      const nonBehavioral = elementTypes.filter((t) => !isBehavioralInterfaceType(t));
      if (nonBehavioral.length > 0) {
        this._diagnostics.push(
          JsiiDiagnostic.JSII_1008_ONLY_INTERFACE_INTERSECTION.create(
            declaration,
            nonBehavioral.map((t) => t.fqn).join(', '),
          ),
        );
      }

      // Check that shared members are the same
      const interfaces = elementTypes.filter(isBehavioralInterfaceType);
      const allProps = Sets.union(...interfaces.map((int) => this.allProperties(int)));
      const allMethods = Sets.union(...interfaces.map((int) => this.allMethods(int)));

      for (let i = 1; i < interfaces.length; i++) {
        let int0 = interfaces[0];
        let int1 = interfaces[i];

        for (const prop of allProps) {
          const p1 = int0.properties?.find((p) => p.name === prop);
          const p2 = int1.properties?.find((p) => p.name === prop);
          const diff = this.comparePropForIntersection(p1, p2);
          if (diff) {
            this._diagnostics.push(
              JsiiDiagnostic.JSII_1011_INTERSECTION_MEMBER_DIFFERENT.create(
                declaration,
                prop,
                int0.name,
                diff[0],
                int1.name,
                diff[1],
              ),
            );
          }
        }

        for (const meth of allMethods) {
          const m1 = int0.methods?.find((p) => p.name === meth);
          const m2 = int1.methods?.find((p) => p.name === meth);
          const diff = this.compareMethodForIntersection(m1, m2);
          if (diff) {
            this._diagnostics.push(
              JsiiDiagnostic.JSII_1011_INTERSECTION_MEMBER_DIFFERENT.create(
                declaration,
                meth,
                int0.name,
                diff[0],
                int1.name,
                diff[1],
              ),
            );
          }
        }
      }
    });
  }

  private comparePropForIntersection(
    a: spec.Property | undefined,
    b: spec.Property | undefined,
  ): [string, string] | undefined {
    if (!a || !b) {
      return undefined;
    }

    if (!typeReferenceEqual(a.type, b.type)) {
      return [typeReferenceToString(a.type), typeReferenceToString(b.type)];
    }

    return (
      cmpDesc(a.static, b.static, (s) => (s ? 'static' : 'instance member')) ??
      cmpDesc(a.optional, b.optional, (o) => (o ? 'optional' : 'required')) ??
      cmpDesc(a.abstract, b.abstract, (s) => (s ? 'abstract' : 'concrete'))
    );
  }

  private compareMethodForIntersection(
    a: spec.Method | undefined,
    b: spec.Method | undefined,
  ): [string, string] | undefined {
    if (!a || !b) {
      return undefined;
    }

    if (a.returns && b.returns) {
      if (!typeReferenceEqual(a.returns.type, b.returns.type)) {
        return [typeReferenceToString(a.returns.type), typeReferenceToString(b.returns.type)];
      }

      const x = cmpDesc(a.returns.optional, b.returns.optional, (o) =>
        o ? 'return type optional' : 'return type required',
      );
      if (x) {
        return x;
      }
    }

    const paramsA = a.parameters ?? [];
    const paramsB = b.parameters ?? [];
    if (paramsA.length !== paramsB.length) {
      return [`${paramsA.length} parameters`, `${paramsB.length} parameters`];
    }
    for (let i = 0; i < paramsA.length; i++) {
      const p1 = paramsA[i];
      const p2 = paramsB[i];

      if (!typeReferenceEqual(p1.type, p2.type)) {
        return [typeReferenceToString(p1.type), typeReferenceToString(p2.type)];
      }

      const x =
        cmpDesc(p1.optional, p2.optional, (o) => (o ? `parameter ${i + 1} optional` : `parameter ${i + 1} required`)) ??
        cmpDesc(p1.variadic, p2.variadic, (v) =>
          v ? `parameter ${i + 1} variadic` : `parameter ${i + 1} not variadic`,
        );
      if (x) {
        return x;
      }
    }

    return (
      cmpDesc(a.abstract, b.abstract, (s) => (s ? 'abstract' : 'concrete')) ??
      cmpDesc(a.async, b.async, (s) => (s ? 'async' : 'async')) ??
      cmpDesc(a.protected, b.protected, (p) => (p ? 'protected' : 'public')) ??
      cmpDesc(a.variadic, b.variadic, (v) => (v ? 'variadic' : 'non-variadic')) ??
      cmpDesc(a.static, b.static, (s) => (s ? 'static' : 'instance member'))
    );
  }

  private callDeferredsInOrder() {
    // Do a topological call order of all deferreds.
    while (this._deferred.length > 0) {
      // All fqns in dependency lists that don't have any pending
      // deferreds themselves can be executed now, so are removed from
      // dependency lists.
      const pendingFqns = new Set<string>(this._deferred.map((x) => x.fqn).filter((x) => x));
      for (const deferred of this._deferred) {
        restrictDependenciesTo(deferred, pendingFqns);
      }

      // Invoke all deferreds with no more dependencies and remove them from the list.
      let invoked = false;
      for (let i = 0; i < this._deferred.length; i++) {
        if (this._deferred[i].dependedFqns.length === 0) {
          const deferred = this._deferred.splice(i, 1)[0];
          deferred.cb();
          invoked = true;
        }
      }

      if (!invoked) {
        // Apparently we're stuck. Complain loudly.
        throw new Error(
          `Could not invoke any more deferreds, cyclic dependency? Remaining: ${JSON.stringify(
            this._deferred,
            undefined,
            2,
          )}`,
        );
      }
    }

    /**
     * Retain only elements in the dependencyfqn that are also in the set
     */
    function restrictDependenciesTo(def: DeferredRecord, fqns: Set<string>) {
      def.dependedFqns = def.dependedFqns.filter(fqns.has.bind(fqns));
    }
  }

  /**
   * Return the set of all (inherited) properties of an interface
   */
  private allProperties(root: spec.InterfaceType): Set<string> {
    return this.allInterfacesRecursively(root, (int) => {
      return (int.properties ?? []).map((p) => p.name);
    });
  }

  /**
   * Return the set of all (inherited) methods of an interface
   */
  private allMethods(root: spec.InterfaceType): Set<string> {
    return this.allInterfacesRecursively(root, (int) => {
      return (int.methods ?? []).map((p) => p.name);
    });
  }

  private allInterfacesRecursively<T>(root: spec.InterfaceType, cb: (x: spec.InterfaceType) => Iterable<T>): Set<T> {
    const ret = new Set<T>();
    recurse.call(this, root);
    return ret;

    function recurse(this: Assembler, int: spec.InterfaceType) {
      for (const x of cb(int)) {
        ret.add(x);
      }

      for (const baseRef of int.interfaces ?? []) {
        const base = this._dereference(baseRef, undefined, 'used-in-syntax');
        if (!base) {
          throw new Error('Impossible to have unresolvable base in allInterfacesRecursively()');
        }
        if (!spec.isInterfaceType(base)) {
          throw new Error('Impossible to have non-interface base in allInterfacesRecursively()');
        }

        recurse.call(this, base);
      }
    }
  }

  private _verifyConsecutiveOptionals(node: ts.Node, parameters?: spec.Parameter[]) {
    if (!parameters) {
      return;
    }

    const remaining = [...parameters].reverse();
    while (remaining.length > 0) {
      const current = remaining.pop()!;
      if (current.optional) {
        const offender = remaining.find((p) => !p.optional && !p.variadic);
        if (offender == null) {
          continue;
        }
        this._diagnostics.push(
          JsiiDiagnostic.JSII_3009_OPTIONAL_PARAMETER_BEFORE_REQUIRED.create(node, current, offender),
        );
        delete current.optional;
      }
    }
  }

  /**
   * Updates the runtime type info with the fully-qualified name for the current class definition.
   * Used by the runtime type info injector to add this information to the compiled file.
   */
  private registerExportedClassFqn(clazz: ts.ClassDeclaration, fqn: string) {
    this.runtimeTypeInfoInjector.registerClassFqn(clazz, fqn);
  }

  /**
   * Return only those submodules from the submodules list that are submodules inside this
   * assembly.
   */
  private mySubmodules() {
    return Array.from(this._submodules.values()).filter((m) => m.fqn.startsWith(`${this.projectInfo.name}.`));
  }

  private findPackageInfo(fromDir: string): PackageJson | undefined {
    if (this._packageInfoCache.has(fromDir)) {
      return this._packageInfoCache.get(fromDir);
    }

    const packageInfo = _findPackageInfo.call(this, fromDir);
    this._packageInfoCache.set(fromDir, packageInfo);
    return packageInfo;

    function _findPackageInfo(this: Assembler, dir: string): PackageJson | undefined {
      const filePath = path.join(dir, 'package.json');
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        return undefined;
      }
      return this.findPackageInfo(parent);
    }
  }

  /**
   * Validate types against input/output positions in functions and APIs
   *
   * Currently used to validate that intersection types are only used in input position,
   * not output position
   */
  private validateTypesAgainstPositions() {
    const self = this;

    const validatedFqns = {
      in: new Set<string>(),
      out: new Set<string>(),
    };

    for (const type of this._types.values()) {
      if (spec.isClassType(type)) {
        for (const ctorParam of type.initializer?.parameters ?? []) {
          validateRefFor.call(this, 'in', ctorParam.type, `a constructor parameter of ${type.name}`);
        }
      }
      if (spec.isClassType(type) || isBehavioralInterfaceType(type)) {
        for (const property of type.properties ?? []) {
          validateRefFor.call(this, 'out', property.type, `type of property ${type.name}.${property.name}`);
        }

        for (const method of type.methods ?? []) {
          for (const param of method.parameters ?? []) {
            validateRefFor.call(this, 'in', param.type, `a parameter of method ${type.name}.${method.name}()`);
          }
          if (method.returns) {
            validateRefFor.call(
              this,
              'out',
              method.returns.type,
              `return type of method ${type.name}.${method.name}()`,
            );
          }
        }
      }
    }

    function validateRefFor(dir: 'in' | 'out', typeRef: spec.TypeReference, reason: string) {
      visitTypeReference(typeRef, {
        named: (ref) => {
          // Named types we'll only validate once for every direction
          if (validatedFqns[dir].has(ref.fqn)) {
            return;
          }
          validatedFqns[dir].add(ref.fqn);

          const type = self._dereference(ref, undefined, 'just-validating');
          if (!type) {
            // Maybe this is an unexported type.
            return;
          }
          validateTypeFor(dir, type, reason);
        },
        primitive: () => {},
        collection: (ref) => {
          validateRefFor(dir, ref.collection.elementtype, reason);
        },
        union: (ref) => {
          for (const t of ref.union.types) {
            validateRefFor(dir, t, reason);
          }
        },
        intersection: (ref) => {
          if (dir === 'out') {
            self._diagnostics.push(JsiiDiagnostic.JSII_1009_INTERSECTION_ONLY_INPUT.createDetached(reason));
          }

          for (const t of ref.intersection.types) {
            validateRefFor(dir, t, reason);
          }
        },
      });
    }

    function validateTypeFor(dir: 'in' | 'out', type: spec.Type, reason: string) {
      visitType(type, {
        dataType: (t) => {
          // We only need to validate data types, because classes and interfaces
          // are done as part of the main loop.
          //
          // Recurse.
          for (const prop of t.properties ?? []) {
            validateRefFor(dir, prop.type, `type of property ${t.name}.${prop.name}, ${reason}`);
          }
        },
        classType: () => {},
        interfaceType: () => {},
        enumType: () => {},
      });
    }
  }

  /**
   * Make sure that no 2 submodules are emitting into the same target namespaces
   */
  private validateSubmoduleConfigs() {
    const self = this;
    const dotNetnamespaces: Record<string, string[]> = {};
    const javaPackages: Record<string, string[]> = {};
    const pythonModules: Record<string, string[]> = {};
    const goPackages: Record<string, string[]> = {};

    for (const submodule of this._submodules.values()) {
      const targets = submodule.targets as AssemblyTargets | undefined;

      if (targets?.dotnet?.namespace) {
        accumList(dotNetnamespaces, targets.dotnet.namespace, submodule.fqn);
      }
      if (targets?.java?.package) {
        accumList(javaPackages, targets.java.package, submodule.fqn);
      }
      if (targets?.python?.module) {
        accumList(pythonModules, targets.python.module, submodule.fqn);
      }
      if (targets?.go?.packageName) {
        accumList(goPackages, targets.go.packageName, submodule.fqn);
      }
    }

    maybeError('dotnet', dotNetnamespaces);
    maybeError('java', javaPackages);
    maybeError('python', pythonModules);
    maybeError('go', goPackages);

    function accumList(set: Record<string, string[]>, key: string, value: string) {
      if (!set[key]) {
        set[key] = [];
      }
      set[key].push(value);
    }

    function maybeError(language: string, set: Record<string, string[]>) {
      for (const [namespace, modules] of Object.entries(set)) {
        if (modules.length > 1) {
          self._diagnostics.push(
            JsiiDiagnostic.JSII_4010_SUBMODULE_NAMESPACE_CONFLICT.create(undefined, language, namespace, modules),
          );
        }
      }
    }
  }
}

>>>>>>> b3130d6 (fix: diagnose "types" outside of tsc outDir (#2924))
export interface AssemblerOptions {
  /** package.json contents of the package being assembled. */
  readonly packageJson: any;
  /** The fully-resolved jsii project info (targets, metadata, dependency closure, ...). */
  readonly projectInfo: ProjectInfo;
  /** The rendered package README, when one exists. */
  readonly readme?: spec.ReadMe;
  /** Absolute path to the package root. */
  readonly projectRoot: string;
  /** Absolute path to the entrypoint .ts (derived from `types`/`main`). */
  readonly entry: string;
  /** Assembly name (package name). */
  readonly assemblyName: string;
  /** Default stability for the package. */
  readonly defaultStability?: spec.Stability;
  /** Whether to strip deprecated members (cdk-build.stripDeprecated). */
  readonly stripDeprecated?: boolean;
  /** Optional allowlist file of FQNs to strip (one per line). */
  readonly stripDeprecatedAllowListFile?: string;
  /**
   * The effective tsc `rootDir`/`outDir` of the compilation, recorded in the
   * assembly metadata. Defaults to the values of the jsii config.
   */
  readonly tscRootDir?: string;
  readonly tscOutDir?: string;
}

interface RegisteredType {
  readonly name: string;
  readonly sym: any;
  readonly decl: any;
  readonly fqn: string;
}

/**
 * Load the `.jsiirc.json` targets of a submodule: `<dir>/.jsiirc.json` for a
 * directory module (`index.ts`), `.<name>.jsiirc.json` next to a file module.
 * Invalid target configuration throws a JsiiError, like the classic compiler.
 */
function loadSubmoduleTargetConfig(submoduleMain: string): spec.Submodule['targets'] {
  const dirname = path.dirname(submoduleMain);
  const basenameWithoutExtension = path.basename(submoduleMain).replace(/(\.d)?\.ts$/, '');
  const jsiirc =
    basenameWithoutExtension === 'index'
      ? path.resolve(dirname, '.jsiirc.json')
      : path.resolve(dirname, `.${basenameWithoutExtension}.jsiirc.json`);
  if (!fs.existsSync(jsiirc)) {
    return undefined;
  }
  const data = JSON.parse(fs.readFileSync(jsiirc, 'utf-8'));
  return validateTargets(data.targets) as spec.Submodule['targets'];
}

/**
 * Load the README for a submodule: `README.md` in the directory of a directory
 * module, `<name>.README.md` next to a file module. Literate examples are
 * rendered relative to the project root, like the package README.
 */
<<<<<<< HEAD
function loadSubmoduleReadMe(submoduleMain: string, projectRoot: string): spec.ReadMe | undefined {
  const fileBase = path.basename(submoduleMain).replace(/(\.d)?\.ts$/, '');
  const readMeName = fileBase === 'index' ? 'README.md' : `${fileBase}.README.md`;
  const readmePath = path.join(path.dirname(submoduleMain), readMeName);
=======
function isErrorType(t: ts.Type) {
  return (t as any).intrinsicName === 'error';
}

/**
 * Those have specific semantics in certain languages that don't always translate cleanly in others
 * (like how equals/hashCode are not a thing in Javascript, but carry meaning in Java and C#). The
 * `build` name is reserved for generated code (Java builders use that).
 */
const PROHIBITED_MEMBER_NAMES = ['build', 'equals', 'hashcode'];

/**
 * Whether the given name is prohibited
 */
function isProhibitedMemberName(name: string) {
  return PROHIBITED_MEMBER_NAMES.includes(name.toLowerCase());
}

/**
 * Information about the context in which a declaration is emitted.
 */
class EmitContext {
  public constructor(public readonly namespace: readonly string[], public readonly stability?: spec.Stability) {}

  /**
   * Create a new EmitContext by appending a namespace entry at the end.
   * @param element the new namespace entry.
   */
  public appendNamespace(element: string) {
    return new EmitContext([...this.namespace, element], this.stability);
  }

  /**
   * Create a new EmitContext by replacing the stability.
   * @param stability the new stability, if available.
   */
  public replaceStability(stability?: spec.Stability) {
    if (!stability) {
      return this;
    }
    return new EmitContext(this.namespace, stability);
  }

  /**
   * Create a new EmitContext without stability.
   */
  public removeStability() {
    return new EmitContext(this.namespace, undefined);
  }
}

/** Whether a path that is relative to some directory points outside of that directory. */
function isOutsideOfDirectory(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}

function inferRootDir(program: ts.Program): string | undefined {
  const directories = program
    .getRootFileNames()
    .filter((fileName) => {
      const sourceFile = program.getSourceFile(fileName);
      return (
        sourceFile != null &&
        !program.isSourceFileFromExternalLibrary(sourceFile) &&
        !program.isSourceFileDefaultLibrary(sourceFile)
      );
    })
    .map((fileName) => path.relative(program.getCurrentDirectory(), path.dirname(fileName)))
    .map(segmentPath);

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

/**
 * Determines whether the provided type is a single-valued enum. It is necessary
 * to check as enums are union-like in the type model, and single-valued enum
 * types are actually reduced to the only available literal, which can trip
 * the assembler.
 *
 * @param type        the type being checked.
 * @param typeChecker the type checker to use to get more information.
 *
 * @return `true` if `type` is a single-valued enum type.
 */
function isSingleValuedEnum(type: ts.Type, typeChecker: ts.TypeChecker): type is ts.EnumType {
  if (type.isLiteral() && _isEnumLike(type)) {
    // Single-Valued enums are reduced to the only literal available.
    return type === typeChecker.getBaseTypeOfLiteralType(type);
  }
  return false;
}

/**
 * Checks is the provided type is "this" (as a type annotation).
 *
 * @param type        the validated type.
 * @param typeChecker the type checker.
 *
 * @returns `true` iif the type is `this`
 */
function _isThisType(type: ts.Type, typeChecker: ts.TypeChecker, enclosingDeclaration: ts.Node | undefined): boolean {
  return (
    typeChecker.typeToTypeNode(type, enclosingDeclaration, ts.NodeBuilderFlags.None)?.kind === ts.SyntaxKind.ThisKeyword
  );
}

/**
 * Gets the name node for a given symbol; or it's first declaration if no name can be found. This is
 * intended for use in placing problem markers on the right location.
 *
 * @param symbol the symbol for which the name node is needed.
 *
 * @returns the name node for the symbol, or the symbol's first declaration.
 */
function _nameOrDeclarationNode(symbol: ts.Symbol): ts.Node | undefined {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration == null) {
    return undefined;
  }
  return ts.getNameOfDeclaration(declaration) ?? declaration;
}

function _findHint(decl: ts.Declaration, hint: string): ts.JSDocTag | undefined {
  const [node] = ts.getAllJSDocTags(decl, (tag): tag is ts.JSDocTag => tag.tagName.text === hint);
  return node;
}

function containsIntersection(type: spec.TypeReference): boolean {
  if (spec.isIntersectionTypeReference(type)) {
    return true;
  }
  if (spec.isUnionTypeReference(type)) {
    return type.union.types.some(containsIntersection);
  }
  if (spec.isCollectionTypeReference(type)) {
    return containsIntersection(type.collection.elementtype);
  }
  return false;
}

/**
 * A location where a type can be used.
 */
type TypeUseKind =
  | 'base class'
  | 'base interface'
  | 'list element type'
  | 'map element type'
  | 'parameter type'
  | 'property type'
  | 'return type';

/**
 * Resolve a Type to Symbol, taking into account single-valued enums which have a bug
 *
 * Bug reference: https://github.com/microsoft/TypeScript/issues/46755
 */
function symbolFromType(type: ts.Type, typeChecker: ts.TypeChecker): ts.Symbol {
  if ((type.flags & ts.TypeFlags.EnumLiteral) === 0) {
    return type.symbol;
  }

  const decl = type.symbol.declarations?.[0];
  if (!decl) {
    return type.symbol;
  }

  if (!ts.isEnumMember(decl)) {
    return type.symbol;
  }

  const parentDecl = decl.parent;
  if (!parentDecl || !ts.isEnumDeclaration(parentDecl)) {
    return type.symbol;
  }

  const name = ts.getNameOfDeclaration(parentDecl);
  if (!name) {
    return type.symbol;
  }
  return typeChecker.getSymbolAtLocation(name) ?? type.symbol;
}

const SYMBOLID_CACHE = new WeakMap<spec.Assembly, Record<string, string>>();

/**
 * Build and return an index of { symbolId -> fqn }
 *
 * Uses a cache for performance reasons.
 */
function symbolIdIndex(asm: spec.Assembly): Record<string, string> {
  const existing = SYMBOLID_CACHE.get(asm);
  if (existing) {
    return existing;
  }

  const ret = buildIndex();
  SYMBOLID_CACHE.set(asm, ret);
  return ret;

  function buildIndex() {
    const index: Record<string, string> = {};
    for (const [fqn, type] of Object.entries(asm.types ?? {})) {
      if (type.symbolId) {
        index[type.symbolId] = fqn;
      }
    }
    return index;
  }
}

function getSymbolFromDeclaration(decl: ts.Declaration, typeChecker: ts.TypeChecker): ts.Symbol | undefined {
  const name = ts.getNameOfDeclaration(decl);
  return name ? typeChecker.getSymbolAtLocation(name) : undefined;
}

function isTupleType(type: ts.ObjectType): type is ts.TupleType {
  if (type.objectFlags & ts.ObjectFlags.Tuple) {
    return true;
  }

  if (type.objectFlags & ts.ObjectFlags.Reference) {
    return isTupleType((type as ts.TypeReference).target);
  }

  return false;
}

function isUnder(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return !relative.startsWith(path.sep) && !relative.startsWith('..');
}

function loadAndRenderReadme(readmePath: string, projectRoot: string) {
>>>>>>> b3130d6 (fix: diagnose "types" outside of tsc outDir (#2924))
  if (!fs.existsSync(readmePath)) {
    return undefined;
  }
  return {
    markdown: literate
      .includeAndRenderExamples(
        literate.loadFromFile(readmePath),
        literate.fileSystemLoader(path.dirname(readmePath)),
        projectRoot,
      )
      .join('\n'),
  };
}

/**
 * Splits the inside of a `{@link ...}` tag into its target and label. The label
 * follows a `|`, or the first whitespace when there is no `|`.
 */
function splitLinkTarget(body: string): { target: string; label: string } {
  const trimmed = body.trim();
  const pipe = trimmed.indexOf('|');
  if (pipe >= 0) {
    return { target: trimmed.slice(0, pipe).trim(), label: trimmed.slice(pipe + 1).trim() };
  }
  const space = trimmed.search(/\s/);
  return space < 0
    ? { target: trimmed, label: '' }
    : { target: trimmed.slice(0, space), label: trimmed.slice(space).trim() };
}

/**
 * Renders the `{@link}` tags in a JSDoc tag's text. Labeled links become
 * `{@link target | label}`; unlabeled links keep the classic trailing space.
 */
function renderTagLinks(text: string): string {
  return text.replace(/\{@(link|linkcode|linkplain)\s+([^}]*?)\s*\}/g, (_, kind: string, body: string) => {
    const { target, label } = splitLinkTarget(body);
    return label ? `{@${kind} ${target} | ${label}}` : `{@${kind} ${target} }`;
  });
}

/**
 * Orders the constituents of a union the way the classic compiler emitted them.
 *
 * The classic assembler kept the checker's own order, in which the constituents
 * are sorted by type id, i.e. by the order the types were created in. That order
 * is not observable through the TypeScript 7 API, so it is approximated: the
 * intrinsic primitives first (any, string, number, boolean), then named types in
 * declaration order (program file order, then position in the file; types of
 * dependencies before own types), then collections in their declared order, and
 * nested unions ranked by their first constituent.
 */
function sortUnionLikeClassic(
  refs: readonly spec.TypeReference[],
  rankOfFqn: (fqn: string) => number,
): spec.TypeReference[] {
  const rank = (ref: spec.TypeReference): number => {
    if (spec.isPrimitiveTypeReference(ref)) {
      const order = [
        spec.PrimitiveType.Any,
        spec.PrimitiveType.String,
        spec.PrimitiveType.Number,
        spec.PrimitiveType.Boolean,
        spec.PrimitiveType.Date,
        spec.PrimitiveType.Json,
      ].indexOf(ref.primitive);
      return order < 0 ? 10 : order;
    }
    if (spec.isNamedTypeReference(ref)) {
      return rankOfFqn(ref.fqn);
    }
    if (spec.isCollectionTypeReference(ref)) {
      // Arrays of primitives are instantiated early (the standard library uses
      // them, after the primitives themselves); maps and other collections when
      // first referenced, i.e. after the named types of the union. The relative
      // order of the late collections is kept.
      const element = ref.collection.elementtype;
      if (ref.collection.kind === spec.CollectionKind.Array && spec.isPrimitiveTypeReference(element)) {
        return 50 + rank(element);
      }
      return Number.MAX_SAFE_INTEGER / 2;
    }
    if (spec.isUnionTypeReference(ref)) {
      return Math.min(...ref.union.types.map(rank));
    }
    return Number.MAX_SAFE_INTEGER;
  };
  return refs
    .map((ref, index) => ({ ref, index, rank: rank(ref) }))
    .sort((l, r) => l.rank - r.rank || l.index - r.index)
    .map(({ ref }) => ref);
}

/**
 * Member ordering of the classic assembler (`_sortMembers`): static members
 * first, then immutable, then required, then lexicographical by name.
 */
function compareMembers(l: any, r: any): number {
  const key = (m: any) => [m.static ? '0' : '1', m.immutable ? '0' : '1', !m.optional ? '0' : '1', m.name].join('|');
  return key(l).localeCompare(key(r));
}

export class Assembler {
  private readonly ts: TypeScriptApi;
  private readonly checker: any;
  private readonly program: any;
  private readonly project: TypeScriptProject;

  private readonly root: string;
  private readonly assemblyName: string;
  private readonly entry: string;
  private readonly defaultStability?: spec.Stability;
  private currentStability?: spec.Stability;

  private readonly types: Record<string, spec.Type> = {};
  private readonly submodules: Record<string, spec.Submodule> = {};
  private readonly typeFqnBySymbolId = new Map<unknown, string>();
  private readonly exported: RegisteredType[] = [];

  // Perf caches: memoize per-symbol doc reads (each is an RPC), keyed by
  // the symbol's declaration coordinate (path:index), which is stable.
  private readonly _jsDocTagsCache = new Map<string, any[]>();
  private readonly _docCommentCache = new Map<string, any>();
  private readonly _sourceTextCache = new Map<string, string>();
  private _docCacheHits = 0;

  /** Number of doc-read cache hits (RPCs avoided). Exposed for perf reporting. */
  public get docCacheHits(): number {
    return this._docCacheHits;
  }

  /** The jsii diagnostics (warnings and errors) collected while assembling. */
  public get diagnostics(): readonly JsiiDiagnostic[] {
    return this._diagnostics;
  }

  private readonly _diagnostics = new Array<JsiiDiagnostic>();

  /** The jsii features the assembly makes use of (classic `usedFeatures`). */
  private readonly usedFeatures = new Set<spec.JsiiFeature>();

  /** FQNs of classes without their own constructor, whose initializer is the base type's. */
  private readonly inheritsInitializer = new Set<string>();

  /** Declaration rank of each own type FQN, for ordering union constituents (see _declarationRank). */
  private readonly declarationRanks = new Map<string, number>();
  private programFileIndex?: Map<string, number>;

  // external dependency assemblies (peerDependencies): name -> Set(type names)
  private readonly externalDeps = new Map<string, Set<string>>();
  // full type records of external dependency assemblies, keyed by fqn (for
  // datatype propagation across assembly boundaries)
  private readonly externalTypeByFqn = new Map<string, any>();
  // dependency name -> (symbolId within that dependency -> fqn), the primary way
  // foreign symbols are mapped back to the types of the assembly declaring them
  private readonly externalFqnBySymbolId = new Map<string, Map<string, string>>();
  // dependency name -> its loaded assembly (metadata drives the symbolId path mapping)
  private readonly externalAssemblies = new Map<string, spec.Assembly>();
  // real directory of each loaded dependency -> dependency name. Declarations are
  // attributed to a dependency by path prefix, which also works when the package
  // is reached through a symlink (workspaces, linked fixtures) and the checker
  // reports the resolved path, where no `node_modules` segment is present.
  private readonly externalDepDirs = new Map<string, string>();
  private readonly stripDeprecated: boolean;
  private stripAllowList?: Set<string>;
  // Type symbols dropped by --strip-deprecated. Unlike genuinely unexported
  // (erased) bases, a stripped base is a *named* type that strada's
  // DeprecatedRemover deletes post-assembly WITHOUT folding its members into
  // subclasses — so member re-listing must not treat it as an erased base.
  private readonly strippedTypeSymIds = new Set<unknown>();

  public constructor(ts: TypeScriptApi, project: TypeScriptProject, private readonly options: AssemblerOptions) {
    this.ts = ts;
    this.project = project;
    this.program = project.program;
    this.checker = project.checker;
    this.root = options.projectRoot;
    this.assemblyName = options.assemblyName;
    this.entry = options.entry;
    this.defaultStability = options.defaultStability;
    this.currentStability = options.defaultStability;
    this.stripDeprecated = !!options.stripDeprecated;

    if (options.stripDeprecatedAllowListFile && fs.existsSync(options.stripDeprecatedAllowListFile)) {
      this.stripAllowList = new Set(
        fs
          .readFileSync(options.stripDeprecatedAllowListFile, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );
    }
  }

  /**
   * Build the assembly. Mirrors strada `Assembler.emit()`'s high-level flow:
   * load dependency assemblies, walk module exports, register types, visit each.
   */
  public assemble(): spec.Assembly {
    this._loadDependencyAssemblies();

    const entrySf = this.program.getSourceFile(this.entry);
    if (!entrySf) {
      throw new Error(`ts: entrypoint not found: ${this.entry}`);
    }
    const moduleSymbol = this.checker.getSymbolAtLocation(entrySf);
    const moduleExports = this.checker.getExportsOfModule(moduleSymbol);

    this._registerModuleExports(moduleExports);

    for (const { name, sym, decl, fqn } of this.exported) {
      this._visitNode(name, sym, decl, fqn);
    }

    this._propagateDatatype();

    return this._buildAssembly();
  }

  // -------------------------------------------------------------------------
  // symbol / alias helpers
  // -------------------------------------------------------------------------

  private _resolveAlias(sym: any): any {
    const { SymbolFlags } = this.ts;
    let s = sym;
    while ((s.flags & SymbolFlags.Alias) !== 0) {
      s = this.checker.getAliasedSymbol(s);
    }
    return s;
  }

  /**
   * Whether a symbol is hidden from the jsii type model: marked `@internal`,
   * named with a leading underscore, or ignored with `@jsii ignore` on every one
   * of its declarations (the classic `_isPrivateOrInternal`).
   */
  private _isInternal(sym: any): boolean {
    return (
      this._jsDocTags(sym).some((t: any) => t.name === 'internal') || sym.name.startsWith('_') || this._isIgnored(sym)
    );
  }

  /**
   * Whether every declaration of the symbol carries the `@jsii ignore` directive.
   * All declarations must be ignored so that a partially-ignored merged
   * declaration stays a visible part of the public API, as in the classic
   * compiler. The tags of a symbol are aggregated over its declarations, so a
   * merged declaration is checked per declaration on the raw JSDoc text.
   */
  private _isIgnored(sym: any): boolean {
    const decls: any[] = sym.declarations ?? [];
    if (decls.length === 0 || !this._jsDocTags(sym).some((t: any) => isIgnoreDirective(t))) {
      return false;
    }
    if (decls.length === 1) {
      return true;
    }
    return decls.every((handle) => {
      const block = this._leadingJsDocBlock(handle.resolve(this.project));
      return block != null && this._jsDocLines(block).some((line) => /^@jsii\s+ignore(\s|$)/.test(line));
    });

    /** `@jsii ignore` (a `@jsii` tag whose directive text, on any of its lines, is `ignore`). */
    function isIgnoreDirective(tag: any): boolean {
      if (tag.name !== 'jsii') {
        return false;
      }
      const text: string = typeof tag.text === 'string' ? tag.text : (tag.text ?? []).map((p: any) => p.text).join('');
      return text.split(/[\n,]/).some((part) => part.trim().split(/\s+/)[0] === 'ignore');
    }
  }

  private _isDeprecated(sym: any): boolean {
    return this._jsDocTags(sym).some((t: any) => t.name === 'deprecated');
  }

  /**
   * Memoized `symbol.getJsDocTags(checker)`. The same symbol's tags are consulted
   * multiple times per member (isInternal + isDeprecated + _visitDocumentation),
   * and each call is an out-of-process round-trip. Keyed by the symbol's first
   * declaration coordinate `path:index` (a NodeHandle field readable WITHOUT a
   * resolve() RPC and stable across re-materialization — unlike `symbol.id`,
   * which is undefined/unstable here and made the previous cache inert). Results
   * are value-identical to the uncached call (pure read), so parity is unaffected.
   */
  private _jsDocTags(sym: any): any[] {
    const key = this._symbolDocKey(sym);
    if (key == null) {
      return sym.getJsDocTags(this.checker) ?? [];
    }
    let tags: any = this._jsDocTagsCache.get(key);
    if (tags === undefined) {
      tags = sym.getJsDocTags(this.checker) ?? [];
      this._jsDocTagsCache.set(key, tags);
    } else {
      this._docCacheHits++;
    }
    return tags;
  }

  /**
   * The documentation comment of a symbol with `{@link ...}` references rendered
   * the way the classic language service did (`buildLinkParts`): a link whose
   * name resolves keeps its text verbatim, `{@link Name text}`; a link that does
   * not resolve (or uses a `#member` name, which the classic checker never
   * resolved) is rendered as `{@link Name` + ' ' + `text}`, which is where the
   * trailing space in `{@link Foo }` comes from. The TypeScript 7 checker renders
   * links as plain text, so the raw JSDoc block is consulted when it has links.
   */
  private _docCommentWithClassicLinks(sym: any): any {
    const comment = this._docComment(sym);
    if (typeof comment !== 'string' || comment === '') {
      return comment;
    }
    const decl = sym.declarations?.[0]?.resolve(this.project);
    const block = decl ? this._leadingJsDocBlock(decl) : undefined;
    if (!block) {
      return comment;
    }
    // Only the comment part (before the first tag) belongs to the documentation comment.
    const commentLines: string[] = [];
    for (const line of this._jsDocLines(block)) {
      if (/^@/.test(line)) {
        break;
      }
      commentLines.push(line);
    }
    // TypeScript ends a `{@link}` at a newline and leaks the rest of its label as text, so
    // put a label that continues on the next JSDoc line back on one line. The TypeScript 7
    // rendering of such a link is broken, so the raw comment is used instead.
    let rejoined = false;
    const rawComment = commentLines.join('\n').replace(/\{@(?:link|linkcode|linkplain)\b[^}]*\n[^}]*\}/g, (link) => {
      rejoined = true;
      return link.replace(/\s*\n\s*/g, ' ').replace(/\s+\}$/, '}');
    });
    if (!/\{@link(code|plain)?\b/.test(rawComment)) {
      return comment;
    }
    const linkRe = /\{@(link|linkcode|linkplain)([^}\n]*)\}/g;
    let result = comment;
    let cursor = 0;
    let rawRendered = rawComment;
    let allFound = !rejoined;
    let rawCursor = 0;
    for (const m of rawComment.matchAll(linkRe)) {
      // Anchor the search on the (end of the) raw text preceding this link, so a
      // link text that also occurs earlier in the comment is not matched there.
      const preceding = rawComment.slice(rawCursor, m.index).trimEnd().slice(-24).trimStart();
      rawCursor = (m.index ?? 0) + m[0].length;
      if (preceding) {
        const anchor = result.indexOf(preceding, cursor);
        if (anchor >= 0) {
          cursor = anchor + preceding.length;
        }
      }
      const kind = m[1];
      const after = m[2].replace(/^\s+/, '');
      const nm = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:#[A-Za-z_$][\w$]*)*/.exec(after);
      const { target, label } = splitLinkTarget(after);
      let classic: string;
      let modern: string;
      if (label) {
        classic = `{@${kind} ${target} | ${label}}`;
      } else if (!nm || target.includes('://')) {
        classic = `{@${kind} ${target}}`;
      } else {
        // An unresolved name (or a `#member` name, which the classic checker never
        // resolved) keeps the classic trailing space.
        const resolved = !nm[0].includes('#') && this._resolvesLinkName(nm[0], decl);
        classic = resolved ? `{@${kind} ${target}}` : `{@${kind} ${target} }`;
      }
      if (!nm) {
        modern = after;
      } else {
        modern = `${nm[0].replace(/#/g, '.')}${after.slice(nm[0].length)}`;
      }
      rawRendered = rawRendered.replace(m[0], classic);
      // Re-insert the braces where the TypeScript 7 rendering of this link is.
      const at = result.indexOf(modern, cursor);
      if (at < 0) {
        allFound = false;
        continue;
      }
      result = result.slice(0, at) + classic + result.slice(at + modern.length);
      cursor = at + classic.length;
    }
    // A link the TypeScript 7 rendering could not be located for (e.g. `{@link url | text}`
    // is rendered as "text (url)"): fall back to the raw comment with the links rendered.
    return allFound ? result : rawRendered.trim();
  }

  /** Whether a `{@link A.b.c}` name resolves at `location` (classic `getSymbolAtLocation` on the link name). */
  private _resolvesLinkName(name: string, location: any): boolean {
    const { SymbolFlags, SyntaxKind } = this.ts;
    const parts = name.split('.');
    try {
      let sym: any = this.checker.resolveName(
        parts[0],
        SymbolFlags.Type | SymbolFlags.Namespace | SymbolFlags.Value,
        location,
      );
      if (!sym) {
        // Classic fallback for a bare name: a member of the enclosing class/interface.
        let container = location;
        while (
          container &&
          container.kind !== SyntaxKind.ClassDeclaration &&
          container.kind !== SyntaxKind.InterfaceDeclaration
        ) {
          container = container.parent;
        }
        if (container) {
          const containerType = this.checker.getTypeAtLocation(container);
          const containerSym = containerType?.getSymbol?.();
          sym =
            (containerType && this.checker.getPropertyOfType(containerType, parts[0])) ??
            (containerSym && this.checker.getPropertyOfType(this.checker.getTypeOfSymbol(containerSym), parts[0]));
        }
      }
      for (const part of parts.slice(1)) {
        if (!sym) {
          return false;
        }
        if ((sym.flags & SymbolFlags.Alias) !== 0) {
          sym = this.checker.getAliasedSymbol(sym);
        }
        const exported = sym.getExports?.()?.get?.(part);
        if (exported) {
          sym = exported;
          continue;
        }
        const staticType = this.checker.getTypeOfSymbol(sym);
        const declaredType = this.checker.getDeclaredTypeOfSymbol(sym);
        sym =
          (staticType && this.checker.getPropertyOfType(staticType, part)) ??
          (declaredType && this.checker.getPropertyOfType(declaredType, part));
      }
      return sym != null && (sym.declarations?.length ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /** Memoized `symbol.getDocumentationComment(checker)` (keyed by declaration coordinate). */
  private _docComment(sym: any): any {
    const key = this._symbolDocKey(sym);
    if (key == null) {
      return sym.getDocumentationComment(this.checker);
    }
    let doc = this._docCommentCache.get(key);
    if (doc === undefined) {
      doc = sym.getDocumentationComment(this.checker) ?? null;
      this._docCommentCache.set(key, doc);
    } else {
      this._docCacheHits++;
    }
    return doc;
  }

  /** Stable per-symbol key from its first declaration's (path, index); undefined if none. */
  private _symbolDocKey(sym: any): string | undefined {
    const d0 = sym?.declarations?.[0];
    if (!d0 || d0.path == null || d0.index == null) {
      return undefined;
    }
    return `${d0.path}:${d0.index}`;
  }

  /**
   * Documentation is read per symbol: on TypeScript 7.1 the request-batching
   * combinator was measured slower than individual requests for this workload.
   * Kept as a no-op hook so call sites document where a prefetch would go.
   */
  private _prefetchDocs(_syms: any[]): void {
    /* intentionally empty */
  }

  private _shouldStrip(sym: any, fqn: string): boolean {
    if (!this.stripDeprecated || !this._isDeprecated(sym)) {
      return false;
    }
    if (!this.stripAllowList) {
      return true;
    }
    return this.stripAllowList.has(fqn);
  }

  // -------------------------------------------------------------------------
  // external (peer-dependency) assembly resolution
  // -------------------------------------------------------------------------

  private _loadDependencyAssemblies(): void {
    const pkg = this.options.packageJson;
    for (const dep of Object.keys(pkg.peerDependencies ?? {})) {
      try {
        // Resolved like the classic compiler (and independently of the package's
        // `exports` map, which may not expose package.json).
        const depDir = fs.realpathSync(findDependencyDirectory(dep, this.root));
        this.externalDepDirs.set(depDir, dep);
        let depJsii = JSON.parse(fs.readFileSync(path.join(depDir, '.jsii'), 'utf8'));
        if (depJsii.schema === 'jsii/file-redirect') {
          depJsii = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(depDir, depJsii.filename))).toString('utf8'));
        }
        this.externalDeps.set(
          dep,
          new Set(Object.keys(depJsii.types ?? {}).map((f) => f.slice(depJsii.name.length + 1))),
        );
        const bySymbolId = new Map<string, string>();
        for (const [fqn, type] of Object.entries<any>(depJsii.types ?? {})) {
          this.externalTypeByFqn.set(fqn, type);
          if (typeof type.symbolId === 'string') {
            bySymbolId.set(type.symbolId, fqn);
          }
        }
        this.externalFqnBySymbolId.set(dep, bySymbolId);
        this.externalAssemblies.set(dep, depJsii);
      } catch {
        /* not a jsii dependency */
      }
    }
  }

  /**
   * The (alias-resolved) symbol of a heritage-clause entry (`extends X` /
   * `implements X`). Newer API clients materialize some resolved child nodes
   * (e.g. the `expression` of ExpressionWithTypeArguments) as local-only
   * objects that `getSymbolAtLocation` rejects, so prefer resolving the base
   * TYPE at the heritage node itself and taking its symbol.
   */
  private _heritageBaseSymbol(t: any): any {
    const viaExpression = this._symbolAtNodeSafe(t.expression);
    if (viaExpression) {
      return this._resolveAlias(viaExpression);
    }
    const type = this.checker.getTypeAtLocation(t);
    const s = type?.getSymbol?.() ?? type?.symbol;
    return s ? this._resolveAlias(s) : undefined;
  }

  /** `checker.getSymbolAtLocation` that tolerates local-only / missing nodes. */
  private _symbolAtNodeSafe(node: any): any {
    if (node == null) {
      return undefined;
    }
    try {
      return this.checker.getSymbolAtLocation(node);
    } catch {
      return undefined; // not a remote node handle in this API generation
    }
  }

  /** The alias symbol of the type at a node (e.g. a TypeReference to a type alias). */
  private _aliasSymbolAt(node: any): any {
    const type = this.checker.getTypeAtLocation(node);
    return type?.getAliasSymbol?.() ?? type?.aliasSymbol;
  }

  /**
   * The loaded jsii dependency a declaration path belongs to, if any: the
   * dependency whose (real) directory is a prefix of the path, falling back to
   * the `node_modules/<name>/` segment for paths that were not resolved.
   */
  private _dependencyOfPath(declPath: string): string | undefined {
    if (!declPath) {
      return undefined;
    }
    for (const [dir, dep] of this.externalDepDirs) {
      if (declPath === dir || declPath.startsWith(`${dir}/`)) {
        return dep;
      }
    }
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(declPath);
    return m && this.externalDeps.has(m[1]) ? m[1] : undefined;
  }

  private _externalFqnOf(sym: any): string | undefined {
    const decl0 = sym.declarations?.[0];
    if (!decl0) {
      return undefined;
    }
    const dep = this._dependencyOfPath(decl0.path ?? '');
    if (dep == null) {
      return undefined;
    }
    // Primary: match the symbol's identifier against the symbolIds recorded in
    // the dependency's assembly (the classic compiler's symbolIdentifier lookup).
    // The declaration lives in the dependency's compiled output, so its path is
    // mapped from tscOutDir back to tscRootDir first.
    const symbolId = this._symbolIdOf(sym, this.externalAssemblies.get(dep));
    if (symbolId != null) {
      const fqn = this.externalFqnBySymbolId.get(dep)?.get(symbolId);
      if (fqn != null) {
        return fqn;
      }
    }
    // Fallback for assemblies without symbolIds: a top-level type of that name.
    if (this.externalDeps.get(dep)!.has(sym.name)) {
      return `${dep}.${sym.name}`;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // module walk + type registration (strada: _registerNamespaces / _visitNode)
  // -------------------------------------------------------------------------

  private _registerModuleExports(moduleExports: any[]): void {
    const { SyntaxKind, SymbolFlags } = this.ts;
    const candidates = new Map<
      unknown,
      Array<{ name: string; prefix: string; moduleDir: string; sym: any; aliasDeclH?: any }>
    >();
    const visitedModules = new Set<string>();

    const collect = (mExports: any[], prefix: string, moduleDir: string): void => {
      for (const e of mExports) {
        const sym = this._resolveAlias(e);
        const declH = sym.declarations?.[0];
        if (!declH) {
          continue;
        }
        const kind = declH.kind;
        if ([SyntaxKind.ClassDeclaration, SyntaxKind.InterfaceDeclaration, SyntaxKind.EnumDeclaration].includes(kind)) {
          if (this._dependencyOfPath(declH.path ?? '') != null) {
            continue; // peer-dependency type: referenced externally, not owned
          }
          if (!candidates.has(sym.id)) {
            candidates.set(sym.id, []);
          }
          // When the export is an alias, keep its own first declaration handle:
          // it discriminates `export { X } from '...'` (ExportSpecifier with a
          // module specifier — strada visits it in the CURRENT namespace and
          // emits a duplicate entry) from `import { X } ...; export { X };`
          // (strada's ExportSpecifier resolution lands on an ImportSpecifier,
          // which no _visitNode branch handles — silently dropped).
          const aliasDeclH = (e.flags & SymbolFlags.Alias) !== 0 ? e.declarations?.[0] : undefined;
          candidates.get(sym.id)!.push({ name: e.name, prefix, moduleDir, sym, aliasDeclH });
        } else if (
          kind === SyntaxKind.SourceFile ||
          (sym.flags & SymbolFlags.ValueModule) !== 0 ||
          (sym.flags & SymbolFlags.NamespaceModule) !== 0
        ) {
          if (kind !== SyntaxKind.SourceFile && this._isIgnored(sym)) {
            continue; // `@jsii ignore` on a namespace hides all of its nested declarations
          }
          const subFqn = `${prefix}.${e.name}`;
          const key = `${sym.id}:${subFqn}`;
          if (visitedModules.has(key)) {
            continue;
          }
          visitedModules.add(key);
          this.submodules[subFqn] = this._submoduleSpec(e, sym, kind === SyntaxKind.SourceFile);
          const subDir = path.dirname(sym.declarations?.[0]?.path ?? moduleDir);
          collect(this.checker.getExportsOfModule(sym), subFqn, subDir);
        }
      }
    };
    collect(moduleExports, this.assemblyName, path.dirname(this.entry));
    this._validateSubmoduleConfigs();

    // FQN attribution: the *canonical* home of a type is the shortest module
    // path that contains its declaration (the shortest-module-path "best
    // candidate" selection); typeFqnBySymbolId (reference resolution) uses it.
    // A symbol additionally exported from OTHER submodules (cross-submodule
    // re-export, e.g. aws_docdb re-exporting aws_rds.CaCertificate) gets a full
    // duplicate type entry under each such fqn — strada emits one entry per
    // namespace visit.
    const registrations: Array<{ sym: any; name: string; fqn: string }> = [];
    for (const [, cands] of candidates) {
      let best = cands[0];
      let bestLen = -1;
      for (const c of cands) {
        const declPath = c.sym.declarations?.[0]?.path ?? '';
        const dir = c.moduleDir.endsWith('/') ? c.moduleDir : c.moduleDir + '/';
        const len = declPath.startsWith(dir) ? dir.length : -1;
        if (len > bestLen) {
          bestLen = len;
          best = c;
        }
      }
      const bestFqn = `${best.prefix}.${best.name}`;
      registrations.push({ sym: best.sym, name: best.name, fqn: bestFqn });
      const extraFqns = new Set<string>([bestFqn]);
      for (const c of cands) {
        const fqn = `${c.prefix}.${c.name}`;
        if (extraFqns.has(fqn)) {
          continue;
        }
        // Only FOREIGN re-exports (candidate module dir does NOT contain the
        // declaration, e.g. aws_docdb re-exporting a type declared in aws-rds/)
        // produce a duplicate entry. Candidates from ancestor dirs (the package
        // root re-exporting a submodule's type) collapse into the canonical fqn.
        const declPath = c.sym.declarations?.[0]?.path ?? '';
        const dir = c.moduleDir.endsWith('/') ? c.moduleDir : c.moduleDir + '/';
        if (declPath.startsWith(dir)) {
          continue;
        }
        // strada only emits the duplicate for `export { X } from '...'` — the
        // alias declaration must be an ExportSpecifier whose ExportDeclaration
        // carries a module specifier. Aliases that go through a local import
        // (`import { X } ...; export { X };`) are dropped by strada's visitor.
        if (!c.aliasDeclH || c.aliasDeclH.kind !== SyntaxKind.ExportSpecifier) {
          continue;
        }
        const aliasDecl = c.aliasDeclH.resolve(this.project);
        const exportDeclNode = aliasDecl?.parent?.parent;
        if (exportDeclNode?.moduleSpecifier == null) {
          continue;
        }
        extraFqns.add(fqn);
        registrations.push({ sym: c.sym, name: c.name, fqn });
      }
    }
    // Batch-prefetch docs for all candidate type symbols (used by the
    // isInternal/shouldStrip checks inside _registerType).
    this._prefetchDocs(registrations.map((r) => r.sym));
    for (const r of registrations) {
      this._registerType(r.sym, r.name, r.fqn);
    }
  }

  private _registerType(sym: any, name: string, fqn: string): void {
    const { SyntaxKind } = this.ts;
    const isFirst = !this.typeFqnBySymbolId.has(sym.id);
    if (!isFirst) {
      // Already registered under its canonical fqn. A *different* fqn means a
      // cross-submodule re-export: emit a duplicate entry under that fqn too
      // (nested-export recursion runs only for the canonical registration).
      if (this.typeFqnBySymbolId.get(sym.id) === fqn || this.exported.some((e) => e.fqn === fqn)) {
        return;
      }
    }
    if (this._isInternal(sym)) {
      return;
    }
    if (this._shouldStrip(sym, fqn)) {
      this.strippedTypeSymIds.add(sym.id);
      return;
    }
    const decl = sym.declarations?.[0]?.resolve(this.project);
    if (!decl) {
      return;
    }
    if (isFirst) {
      this.typeFqnBySymbolId.set(sym.id, fqn);
    }
    this.exported.push({ name, sym, decl, fqn });
    this._registerDeclarationRank(fqn, sym);
    if (!isFirst) {
      return;
    }

    // nested exported types (namespaces on a class/interface)
    const nested = sym.getExports?.();
    if (nested && nested.size) {
      for (const [, nsym0] of nested) {
        const nsym = this._resolveAlias(nsym0);
        const nDeclH = nsym.declarations?.[0];
        if (!nDeclH) {
          continue;
        }
        if (
          [SyntaxKind.ClassDeclaration, SyntaxKind.InterfaceDeclaration, SyntaxKind.EnumDeclaration].includes(
            nDeclH.kind,
          )
        ) {
          this._registerType(nsym, nsym.name, `${fqn}.${nsym.name}`);
        }
      }
    }
  }

  /**
   * The assembly entry for a submodule (classic `_registerNamespaces`): the
   * location of the `export * as ns from '...'` (or `export namespace ns`)
   * declaration, its symbolId and, for module-file submodules, the targets
   * configured in the module's `.jsiirc.json` and its README.
   *
   * @param exportSym the (alias) symbol the submodule is exported as
   * @param moduleSym the resolved module-like symbol
   * @param isModuleFile whether the submodule is a source file (vs an inline namespace)
   */
  private _submoduleSpec(exportSym: any, moduleSym: any, isModuleFile: boolean): spec.Submodule {
    // Namespace exports (`export * as ns`) and inline namespaces carry their own
    // declaration; a plain module file (SourceFile) has no meaningful position.
    const declH = exportSym.declarations?.[0] ?? moduleSym.declarations?.[0];
    const decl = declH && declH.kind !== this.ts.SyntaxKind.SourceFile ? declH.resolve(this.project) : undefined;
    const result: spec.Submodule = {
      ...(decl ? { locationInModule: this._locationOf(decl) } : {}),
      ...(isModuleFile ? { symbolId: this._symbolIdOf(moduleSym) } : { symbolId: this._symbolIdOf(exportSym) }),
    };
    if (!isModuleFile) {
      return result;
    }
    // The declaration handle's path is lowercased on case-insensitive file systems; the
    // source file's name keeps the case, so paths derived from it stay relative to the root.
    const submoduleMain: string | undefined = moduleSym.declarations?.[0]?.resolve(this.project)?.fileName;
    if (submoduleMain == null) {
      return result;
    }
    const targets = loadSubmoduleTargetConfig(submoduleMain);
    const readme = loadSubmoduleReadMe(submoduleMain, this.root);
    return { ...result, ...(targets ? { targets } : {}), ...(readme ? { readme } : {}) };
  }

  /**
   * Make sure that no 2 submodules are emitting into the same target namespaces
   * (classic `validateSubmoduleConfigs`).
   */
  private _validateSubmoduleConfigs(): void {
    const byLanguage: Record<string, Record<string, string[]>> = { dotnet: {}, java: {}, python: {}, go: {} };
    const pick: Record<string, (targets: any) => string | undefined> = {
      dotnet: (t) => t?.dotnet?.namespace,
      java: (t) => t?.java?.package,
      python: (t) => t?.python?.module,
      go: (t) => t?.go?.packageName,
    };
    for (const [fqn, submodule] of Object.entries(this.submodules)) {
      for (const language of Object.keys(byLanguage)) {
        const key = pick[language](submodule.targets);
        if (key) {
          (byLanguage[language][key] ??= []).push(fqn);
        }
      }
    }
    for (const [language, namespaces] of Object.entries(byLanguage)) {
      for (const [namespace, modules] of Object.entries(namespaces)) {
        if (modules.length > 1) {
          this._diagnostics.push(
            JsiiDiagnostic.JSII_4010_SUBMODULE_NAMESPACE_CONFLICT.create(undefined, language, namespace, modules),
          );
        }
      }
    }
  }

  /**
   * Records the inheritance relationships of members and the jsii features the
   * assembly uses, then returns the sorted feature list (or `undefined` when
   * there is none; classic `_assemblyFeatures`).
   *
   * This is the data-producing half of the classic validator's
   * `_inheritanceDoesNotChangeContracts` pass: every member of a class that
   * redeclares a member of a base class gets `overrides` set to that base, and
   * members (own or inherited) that implement an interface member get
   * `overrides` set to that interface, with class overrides taking precedence.
   * `class-covariant-overrides` is recorded when an override changes the type
   * of a non-static member in an allowed covariant way (immutable properties and
   * method return types only). The diagnostics half of that pass (contract
   * violations) is not performed here.
   */
  private _finalizeInheritance(): spec.JsiiFeature[] | undefined {
    const assembly = { name: this.assemblyName, types: this.types } as unknown as spec.Assembly;
    const dereference = createTypeResolver(assembly, [
      ...this.options.projectInfo.dependencyClosure,
      ...this.externalAssemblies.values(),
    ]);
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

    const overrideFromBase = <T extends spec.Method | spec.Property>(
      member: T,
      type: spec.ClassType,
      pick: (t: spec.ClassType) => readonly T[] | undefined,
      isCovariant: (actual: T, expected: T) => boolean,
    ): boolean => {
      const baseType = type.base != null ? (dereference(type.base) as spec.ClassType | undefined) : undefined;
      if (baseType == null) {
        return false;
      }
      const overridden = pick(baseType)?.find((m) => m.name === member.name);
      if (overridden == null) {
        return overrideFromBase(member, baseType, pick, isCovariant);
      }
      if (isCovariant(member, overridden)) {
        this.usedFeatures.add('class-covariant-overrides');
      }
      (member as any).overrides = baseType.fqn;
      return true;
    };

    const implementationOf = <T extends spec.Method | spec.Property>(
      member: T,
      type: spec.ClassType | spec.InterfaceType,
      pick: (t: spec.ClassType | spec.InterfaceType) => readonly T[] | undefined,
    ): boolean => {
      if (!type.interfaces?.length) {
        // Abstract classes may not directly implement all members, need to check their supertypes...
        if (spec.isClassType(type) && type.base && type.abstract) {
          const base = dereference(type.base) as spec.ClassType | undefined;
          return base != null && implementationOf(member, base, pick);
        }
        return false;
      }
      for (const iface of type.interfaces) {
        const ifaceType = dereference(iface) as spec.InterfaceType | undefined;
        if (ifaceType == null) {
          continue;
        }
        if (pick(ifaceType)?.some((m) => m.name === member.name)) {
          // A class override has higher precedence than an initial implementation.
          (member as any).overrides = (member as any).overrides ?? ifaceType.fqn;
          return true;
        }
        if (implementationOf(member, ifaceType, pick)) {
          return true;
        }
      }
      return false;
    };

    // Own members plus the members inherited from base classes (copied, so the
    // inherited entries are not mutated), like the classic `_allImplementations`.
    const allImplementations = <T extends spec.Method | spec.Property>(
      type: spec.ClassType | spec.InterfaceType,
      pick: (t: spec.ClassType | spec.InterfaceType) => readonly T[] | undefined,
    ): T[] => {
      const result: T[] = [...(pick(type) ?? [])];
      const known = new Set(result.map((m) => m.name));
      if (spec.isClassType(type) && type.base) {
        const base = dereference(type.base) as spec.ClassType | undefined;
        for (const member of base ? allImplementations(base, pick) : []) {
          if (!known.has(member.name)) {
            result.push({ ...member });
            known.add(member.name);
          }
        }
      }
      return result;
    };

    // Initializers of classes without their own constructor: copy the base type's
    // (base types first, so chains of such classes resolve).
    const resolveInitializer = (fqn: string, seen = new Set<string>()): void => {
      const type = this.types[fqn] as spec.ClassType | undefined;
      if (type == null || !this.inheritsInitializer.has(fqn) || seen.has(fqn)) {
        return;
      }
      seen.add(fqn);
      this.inheritsInitializer.delete(fqn);
      if (type.base != null && this.inheritsInitializer.has(type.base)) {
        resolveInitializer(type.base, seen);
      }
      const baseType = type.base != null ? (dereference(type.base) as spec.ClassType | undefined) : undefined;
      if (baseType?.initializer != null) {
        (type as any).initializer = JSON.parse(JSON.stringify(baseType.initializer));
      } else {
        delete (type as any).initializer;
      }
    };
    for (const fqn of [...this.inheritsInitializer]) {
      resolveInitializer(fqn);
    }

    const methodCovariant = (actual: spec.Method, expected: spec.Method) =>
      !same(actual.returns, expected.returns) &&
      !actual.static &&
      isAllowedCovariantSubtype(actual.returns?.type, expected.returns?.type, dereference);
    const propertyCovariant = (actual: spec.Property, expected: spec.Property) =>
      !same(actual.type, expected.type) &&
      !actual.static &&
      !!actual.immutable &&
      isAllowedCovariantSubtype(actual.type, expected.type, dereference);

    for (const type of Object.values(this.types) as spec.Type[]) {
      if (spec.isClassType(type)) {
        for (const method of type.methods ?? []) {
          overrideFromBase(method, type, (t) => t.methods, methodCovariant);
        }
        for (const property of type.properties ?? []) {
          overrideFromBase(property, type, (t) => t.properties, propertyCovariant);
        }
      }
      if (spec.isClassOrInterfaceType(type) && (type.interfaces?.length ?? 0) > 0) {
        for (const method of allImplementations<spec.Method>(type, (t) => t.methods)) {
          implementationOf(method, type, (t) => t.methods);
        }
        for (const property of allImplementations<spec.Property>(type, (t) => t.properties)) {
          implementationOf(property, type, (t) => t.properties);
        }
      }
      if (spec.isInterfaceType(type) && this._redeclaresInterfaceMember(type, dereference, same)) {
        this.usedFeatures.add('interface-member-doc-overrides');
      }
    }
    return this.usedFeatures.size > 0 ? Array.from(this.usedFeatures).sort() : undefined;
  }

  /**
   * Whether an interface re-declares an inherited member with exactly the same
   * shape, so that only its documentation differs. `overrides` already points
   * at the nearest base interface that declares the member.
   */
  private _redeclaresInterfaceMember(
    type: spec.InterfaceType,
    dereference: (fqn: string) => spec.Type | undefined,
    same: (a: unknown, b: unknown) => boolean,
  ): boolean {
    const baseMember = <T extends spec.Method | spec.Property>(
      member: T,
      pick: (t: spec.InterfaceType) => readonly T[] | undefined,
    ): T | undefined => {
      const base = member.overrides != null ? dereference(member.overrides) : undefined;
      return base != null && spec.isInterfaceType(base) ? pick(base)?.find((m) => m.name === member.name) : undefined;
    };
    const sameMethod = (member: spec.Method, base: spec.Method) => {
      const params = member.parameters ?? [];
      const baseParams = base.parameters ?? [];
      return (
        !!member.static === !!base.static &&
        !!member.async === !!base.async &&
        same(member.returns, base.returns) &&
        params.length === baseParams.length &&
        params.every(
          (param, i) =>
            same(param.type, baseParams[i].type) &&
            !!param.optional === !!baseParams[i].optional &&
            !!param.variadic === !!baseParams[i].variadic,
        )
      );
    };
    const sameProperty = (member: spec.Property, base: spec.Property) =>
      !!member.static === !!base.static &&
      !!member.optional === !!base.optional &&
      !!member.immutable === !!base.immutable &&
      same(member.type, base.type);

    return (
      (type.methods ?? []).some((m) => {
        const base = baseMember(m, (t) => t.methods);
        return base != null && sameMethod(m, base);
      }) ||
      (type.properties ?? []).some((p) => {
        const base = baseMember(p, (t) => t.properties);
        return base != null && sameProperty(p, base);
      })
    );
  }

  /**
   * Declaration rank of a type FQN for union ordering: own types by (program file
   * order, position in file); types of dependencies before them, by name.
   */
  private _declarationRank(fqn: string): number {
    const own = this.declarationRanks.get(fqn);
    if (own != null) {
      return own;
    }
    if (this.externalTypeByFqn.has(fqn)) {
      const foreign = [...this.externalTypeByFqn.keys()].sort();
      return 1000 + foreign.indexOf(fqn);
    }
    return Number.MAX_SAFE_INTEGER;
  }

  private _registerDeclarationRank(fqn: string, sym: any): void {
    if (this.programFileIndex == null) {
      const files: string[] = this.project.program.getSourceFileNames();
      this.programFileIndex = new Map(files.map((f, i) => [f, i]));
    }
    const d0 = sym.declarations?.[0];
    const file = (d0?.path != null ? this.programFileIndex.get(d0.path) : undefined) ?? this.programFileIndex.size;
    this.declarationRanks.set(fqn, 1_000_000 + file * 1_000_000 + (d0?.index ?? 0));
  }

  /**
   * The symbolId of a symbol, computed by the same `symbolIdentifier` the
   * classic compiler (and jsii-rosetta) use: the path is made relative to the
   * package the declaration lives in, with the package's `jsii.outdir` and, when
   * an assembly is given, its tscOutDir -> tscRootDir mapping applied.
   */
  private _symbolIdOf(sym: any, assembly?: spec.Assembly): string | undefined {
    return symbolIdentifier(this.checker, sym, { assembly });
  }

  // -------------------------------------------------------------------------
  // per-type dispatch (strada: _visitNode)
  // -------------------------------------------------------------------------

  private _visitNode(name: string, sym: any, decl: any, fqn: string): void {
    const { SyntaxKind } = this.ts;
    const jsiiType: any = {
      assembly: this.assemblyName,
      fqn,
      kind: '',
      locationInModule: this._locationOf(decl),
      name,
    };
    // Classic: the namespace is the FQN between the assembly name and the type
    // name (submodules and enclosing types), absent for top-level types.
    const namespace = fqn
      .slice(this.assemblyName.length + 1)
      .split('.')
      .slice(0, -1)
      .join('.');
    if (namespace) {
      jsiiType.namespace = namespace;
    }
    const docs = this._visitDocumentation(sym);
    if (docs) {
      jsiiType.docs = docs;
    }
    this.currentStability = docs?.stability ?? this.defaultStability;
    this._withDefaultDocs(jsiiType);
    const symbolId = this._symbolIdOf(sym);
    if (symbolId) {
      jsiiType.symbolId = symbolId;
    }

    if (decl.kind === SyntaxKind.EnumDeclaration) {
      this._visitEnum(sym, decl, fqn, jsiiType);
    } else if (decl.kind === SyntaxKind.InterfaceDeclaration) {
      this._visitInterface(sym, decl, name, jsiiType);
    } else {
      this._visitClass(sym, decl, jsiiType);
    }
    this.types[fqn] = jsiiType as spec.Type;
  }

  private _visitEnum(sym: any, decl: any, fqn: string, jsiiType: any): void {
    const { SyntaxKind } = this.ts;
    jsiiType.kind = 'enum';
    const members: any[] = [];
    // strada derives enum members from the enum TYPE's union constituents
    // (`type.isUnion() ? type.types : [type]`), not from the declaration. For
    // aliased members (`COLD_HDD = SC1`) the alias shares the canonical member's
    // literal type, so the alias never surfaces as its own constituent — this is
    // why strada emits only canonical members (e.g. EbsDeviceVolumeType).
    const enumMembers: any[] = [];
    const type = this.checker.getTypeAtLocation(decl);
    const constituents = typeof type?.isUnionType === 'function' && type.isUnionType() ? type.getTypes() : [type];
    const seen = new Set<unknown>();
    for (const c of constituents) {
      const ms = c?.getSymbol?.() ?? c?.symbol;
      if (!ms || ms.declarations?.[0]?.kind !== SyntaxKind.EnumMember || seen.has(ms.id)) {
        continue;
      }
      seen.add(ms.id);
      enumMembers.push(ms);
    }
    if (enumMembers.length === 0) {
      // Fallback (single-valued or fully-computed enums where the declared type
      // is not a union of member literals): walk the declaration's exports.
      for (const [, m] of sym.getExports()) {
        enumMembers.push(m);
      }
    }
    this._prefetchDocs(enumMembers);
    for (const msym of enumMembers) {
      if (msym.declarations?.[0]?.kind !== SyntaxKind.EnumMember) {
        continue;
      }
      if (this._isInternal(msym) || this._shouldStrip(msym, `${fqn}#${msym.name}`)) {
        continue;
      }
      const member: any = { name: msym.name };
      const md = this._visitDocumentation(msym);
      if (md) {
        member.docs = md;
      }
      members.push(this._withDefaultDocs(member));
    }
    jsiiType.members = members;
  }

  private _visitInterface(sym: any, decl: any, name: string, jsiiType: any): void {
    jsiiType.kind = 'interface';
    const type = this.checker.getTypeAtLocation(decl);
    const { interfaces, erasedBases } = this._processBaseInterfaces(type.getBaseTypes());
    if (interfaces.length) {
      const rewrittenByStrip = erasedBases.some((b) => this.strippedTypeSymIds.has((b.getSymbol?.() ?? b.symbol)?.id));
      jsiiType.interfaces = rewrittenByStrip ? [...interfaces].sort() : interfaces;
    }
    this._visitMembers(sym, decl, jsiiType, true, erasedBases);

    // datatype (struct) — same sequence as the classic Assembler:
    //   1. an interface with no methods starts as a datatype;
    //   2. behavioral names (`isInterfaceName`: starts with I and has another
    //      capital, so IPSetProperty/IAMUser qualify) drop it again, UNLESS the
    //      `@struct` doc-tag hint forces struct-ness (cfn-generated `I*`
    //      property bags rely on this);
    //   3. extending a non-datatype interface clears it (applied as a fixpoint
    //      post-pass in assemble(), mirroring _deferUntilTypesAvailable).
    // The classic path also validates all-readonly with a JSII_3008 diagnostic;
    // this backend produces no jsii diagnostics, and the flag itself does not
    // depend on that validation.
    if ((jsiiType.methods ?? []).length === 0) {
      const hintsStruct = this._jsDocTags(sym).some((t: any) => t.name === 'struct');
      if (!isInterfaceName(name) || hintsStruct) {
        jsiiType.datatype = true;
      }
    }
  }

  /**
   * Fixpoint post-pass for datatype propagation: an interface loses `datatype`
   * when any of its base interfaces is not a datatype (classic Assembler's
   * "Calculate datatype based on the datatypeness of this interface and all of
   * its parents", run via _deferUntilTypesAvailable). External bases are looked
   * up in the loaded dependency assemblies.
   */
  private _propagateDatatype(): void {
    const isDatatypeBase = (fqn: string): boolean => {
      const own = this.types[fqn];
      if (own) {
        return own.kind !== 'interface' || own.datatype === true;
      }
      const ext = this.externalTypeByFqn.get(fqn);
      if (ext) {
        return ext.kind !== 'interface' || ext.datatype === true;
      }
      return true; // unknown base: leave the flag alone
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const type of Object.values(this.types) as any[]) {
        if (type.kind !== 'interface' || type.datatype !== true) {
          continue;
        }
        if ((type.interfaces ?? []).some((base: string) => !isDatatypeBase(base))) {
          delete type.datatype;
          changed = true;
        }
      }
    }
  }

  /**
   * Flatten a type's base interfaces the way strada's `_processBaseInterfaces`
   * does: keep public/exported base interfaces as `interfaces` entries, but for
   * private/internal bases, erase them and recurse into *their* bases (so their
   * public ancestors surface, and their members get re-listed on this type).
   *
   * `getBaseTypes()` alone under-reports for interfaces whose heritage goes
   * through erased/aliased/multi-`extends` chains — recursion fixes that.
   */
  private _processBaseInterfaces(baseTypes?: any[]): { interfaces: string[]; erasedBases: any[] } {
    const erasedBases: any[] = [];
    const interfaces: string[] = [];
    const seen = new Set<string>();
    const visitedErased = new Set<unknown>();
    if (!baseTypes) {
      return { interfaces, erasedBases };
    }

    const process = (types: any[]): void => {
      for (const iface of types) {
        const s = iface.getSymbol?.() ?? iface.symbol;
        const fqn = s && (this.typeFqnBySymbolId.get(s.id) ?? this._externalFqnOf(s));
        if (fqn) {
          if (!seen.has(fqn)) {
            seen.add(fqn);
            interfaces.push(fqn);
          }
          continue;
        }
        // Not an exported/foreign type: erase it and descend into its own bases,
        // so its public ancestors surface and its members get re-listed here.
        // Guard against heritage cycles / repeated visits (RPC-cost + safety).
        if (s && s.id != null) {
          if (visitedErased.has(s.id)) {
            continue;
          }
          visitedErased.add(s.id);
        }
        erasedBases.push(iface);
        const bases = iface.getBaseTypes?.();
        if (bases && bases.length) {
          process(bases);
        }
      }
    };
    process(baseTypes);
    return { interfaces, erasedBases };
  }

  private _visitClass(sym: any, decl: any, jsiiType: any): void {
    const { SyntaxKind } = this.ts;
    jsiiType.kind = 'class';
    const mods = decl.modifiers ?? [];
    if (mods.some((x: any) => x.kind === SyntaxKind.AbstractKeyword)) {
      jsiiType.abstract = true;
    }

    // heritage (base class + implemented interfaces), flattening erased/local bases
    const base: { value?: string } = {};
    const interfaces = new Set<string>();
    const erasedClassBases: any[] = [];
    // Classic order: a type's own `implements` first, then the interfaces of its
    // erased (non-exported) base classes, in erasure order. Erased interfaces in
    // an `implements` clause contribute their own super interfaces in place.
    const erasedDecls: any[] = [];
    // The classic deprecated-remover rebuilt (and sorted) the interface list when a
    // stripped interface was replaced by its super interfaces, or a stripped base
    // class contributed its interfaces.
    let interfacesRewrittenByStrip = false;
    const collectHeritage = (classDecl: any): void => {
      const deferredBases: any[] = [];
      for (const h of classDecl.heritageClauses ?? []) {
        const isExt = h.token === SyntaxKind.ExtendsKeyword && classDecl.kind !== SyntaxKind.InterfaceDeclaration;
        for (const t of h.types) {
          const s = this._heritageBaseSymbol(t);
          if (!s) {
            continue;
          }
          const fqnRef = this.typeFqnBySymbolId.get(s.id) ?? this._externalFqnOf(s);
          if (isExt) {
            if (fqnRef) {
              base.value ??= fqnRef;
            } else {
              const d0 = s.declarations?.[0]?.resolve(this.project);
              if (d0 && (d0.kind === SyntaxKind.ClassDeclaration || d0.kind === SyntaxKind.InterfaceDeclaration)) {
                if (
                  this.strippedTypeSymIds.has(s.id) &&
                  (d0.heritageClauses ?? []).some((hc: any) => hc.token === SyntaxKind.ImplementsKeyword)
                ) {
                  interfacesRewrittenByStrip = true;
                }
                erasedClassBases.push({ getSymbol: () => s, symbol: s });
                erasedDecls.push(d0);
                deferredBases.push(d0);
              }
            }
          } else if (fqnRef) {
            interfaces.add(fqnRef);
          } else {
            const d0 = s.declarations?.[0]?.resolve(this.project);
            if (d0 && d0.kind === SyntaxKind.InterfaceDeclaration) {
              if (this.strippedTypeSymIds.has(s.id)) {
                interfacesRewrittenByStrip = true;
              }
              erasedClassBases.push({ getSymbol: () => s, symbol: s });
              collectHeritage(d0);
            }
          }
        }
      }
      for (const d0 of deferredBases) {
        collectHeritage(d0);
      }
    };
    collectHeritage(decl);
    if (base.value) {
      jsiiType.base = base.value;
    }
    if (interfaces.size) {
      jsiiType.interfaces = interfacesRewrittenByStrip ? [...interfaces].sort() : [...interfaces];
    }

    // initializer (constructor)
    // Classic: the first constructor declared by the class or by one of its
    // erased base classes (in erasure order).
    const findCtor = (d: any) => d.members?.find((m: any) => m.kind === SyntaxKind.Constructor);
    const ctorOwners = [
      { decl, sym },
      ...erasedClassBases.map((b, i) => ({ decl: erasedDecls[i], sym: b.symbol })),
    ].filter((o) => o.decl?.kind === SyntaxKind.ClassDeclaration);
    const ctorOwner = ctorOwners.find((o) => findCtor(o.decl) != null);
    const effectiveCtor = ctorOwner && findCtor(ctorOwner.decl);
    // The constructor's own symbol carries its documentation (classic read it the same way).
    const ctorSym = ctorOwner?.sym?.getMembers?.()?.get?.('__constructor');
    const ctorPrivate =
      effectiveCtor && (effectiveCtor.modifiers ?? []).some((x: any) => x.kind === SyntaxKind.PrivateKeyword);
    if (ctorPrivate) {
      // private constructor: jsii omits the initializer
    } else if (effectiveCtor) {
      const sig = this.checker.getSignatureFromDeclaration(effectiveCtor);
      const initializer: any = { locationInModule: this._locationOf(effectiveCtor) };
      if (sig) {
        const params = sig.getParameters().map((p: any) => this._visitParameter(p));
        if (params.length) {
          initializer.parameters = params;
          if (params.some((p: any) => p.variadic)) {
            initializer.variadic = true;
          }
          // strada quirk: `initializer.protected` is assigned inside its
          // parameter loop, so a protected ZERO-parameter constructor does not
          // get the flag. Reproduced bug-for-bug for parity.
          if ((effectiveCtor.modifiers ?? []).some((x: any) => x.kind === SyntaxKind.ProtectedKeyword)) {
            initializer.protected = true;
          }
        }
      }
      // strada: initializer docs come from the constructor symbol's JSDoc
      // (summary/remarks + tags like @default), same as any member.
      const ctorDocs = ctorSym ? this._visitDocumentation(ctorSym) : this._docsFromDeclJsDoc(effectiveCtor);
      if (ctorDocs) {
        initializer.docs = ctorDocs;
      }
      jsiiType.initializer = this._withDefaultDocs(initializer);
    } else if (jsiiType.base) {
      // Classic: a class without its own constructor takes the initializer
      // recorded for its base type (own or foreign), verbatim. Resolved once all
      // types are assembled, see _finalizeInheritance.
      this.inheritsInitializer.add(jsiiType.fqn);
    } else {
      // Classic: `{ docs: ctx.stability && { stability } }` with the package-level context.
      const init: any = {};
      if (this.defaultStability) {
        init.docs = { stability: this.defaultStability };
      }
      jsiiType.initializer = init;
    }

    this._visitMembers(sym, decl, jsiiType, false, erasedClassBases);
  }

  // -------------------------------------------------------------------------
  // members (strada: _visitProperty / _visitMethod live under this)
  // -------------------------------------------------------------------------

  private _visitMembers(sym: any, decl: any, jsiiType: any, isInterface: boolean, erasedBases: any[] = []): void {
    const { SyntaxKind, SymbolFlags } = this.ts;
    const type = this.checker.getTypeAtLocation(decl);
    const props: any[] = [];
    const methods: any[] = [];
    // The classic deprecated-remover left an empty list behind when it stripped
    // every member of a kind (`typeInfo.properties ? properties : undefined`).
    let strippedProps = false;
    let strippedMethods = false;

    // Symbol ids of the erased (private/internal/unexported) bases whose members
    // jsii folds into this type: members from those bases must be re-listed here.
    const erasedBaseSymIds = new Set<unknown>();
    for (const eb of erasedBases) {
      const s = eb.getSymbol?.() ?? eb.symbol;
      if (s?.id != null && !this.strippedTypeSymIds.has(s.id)) {
        erasedBaseSymIds.add(s.id);
      }
    }

    const instanceProps = this.checker.getPropertiesOfType(type);
    const staticTypeForPrefetch = !isInterface ? this.checker.getTypeOfSymbol(sym) : undefined;
    const staticPropsForPrefetch = staticTypeForPrefetch ? this.checker.getPropertiesOfType(staticTypeForPrefetch) : [];
    // One RPC for all member docs of this type (instance + static).
    this._prefetchDocs([...instanceProps, ...staticPropsForPrefetch]);

    // Constructor parameter properties are only listed for the EFFECTIVE
    // constructor — the first constructor found on the type itself or along its
    // erased-base chain (strada visits param-props exclusively from that
    // signature). Param-props of a non-effective erased-base constructor (e.g.
    // when the subclass declares its own constructor) are NOT re-listed.
    let effectiveCtorOwnerId: unknown;
    if (!isInterface) {
      if ((decl.members ?? []).some((m: any) => m.kind === SyntaxKind.Constructor)) {
        effectiveCtorOwnerId = sym?.id;
      } else {
        for (const eb of erasedBases) {
          const s = eb.getSymbol?.() ?? eb.symbol;
          const ebDecl = s?.declarations?.[0]?.resolve(this.project);
          if (ebDecl && (ebDecl.members ?? []).some((m: any) => m.kind === SyntaxKind.Constructor)) {
            effectiveCtorOwnerId = s.id;
            break;
          }
        }
      }
    }

    for (const p of instanceProps) {
      if (this._isInternal(p)) {
        continue;
      }
      const pDecl = p.declarations?.[0]?.resolve(this.project);
      if (!pDecl) {
        continue;
      }
      if ((pDecl.modifiers ?? []).some((x: any) => x.kind === SyntaxKind.PrivateKeyword)) {
        continue;
      }
      const isParamProp = pDecl.kind === SyntaxKind.Parameter;
      const owner = isParamProp ? pDecl.parent?.parent : pDecl.parent;
      if (isParamProp) {
        const ownerId = owner === decl ? sym?.id : this.checker.getTypeAtLocation(owner)?.getSymbol?.()?.id;
        if (ownerId == null || ownerId !== effectiveCtorOwnerId) {
          continue;
        }
      } else if (owner !== decl) {
        // Resolve the *declaring* type of this member via the owner declaration
        // node's type symbol. NOTE: do NOT use `p.getParent()` here — for a member
        // obtained from getPropertiesOfType(type) that returns the *queried* type
        // (membership), not the declaring type, which mis-classifies inherited
        // members as own. getTypeAtLocation(owner) gives the declaring type.
        const ownerTypeSym = owner ? this.checker.getTypeAtLocation(owner)?.getSymbol?.() : undefined;
        const ownerId = ownerTypeSym?.id;
        const isOwn = ownerId != null && ownerId === sym?.id;
        const isErasedBase = ownerId != null && erasedBaseSymIds.has(ownerId);
        if (!isOwn && !isErasedBase) {
          // strada re-lists a member only when its declaring declaration belongs
          // to this type or one of its *erased* bases. A member declared on an
          // unexported ancestor reachable only through a NAMED base (e.g.
          // FileOptions behind FingerprintOptions) is NOT re-listed — the named
          // base already re-lists it.
          continue;
        }
      }
      // Stripping applies to the members the classic assembler listed on this type
      // (own and erased-base members), hence after the ownership check above.
      if (this._shouldStrip(p, `${jsiiType.fqn}#${p.name}`)) {
        if ((p.flags & SymbolFlags.Method) !== 0) {
          strippedMethods = true;
        } else {
          strippedProps = true;
        }
        continue;
      }
      if ((p.flags & SymbolFlags.Method) !== 0) {
        const m = this._visitMethod(p, pDecl, false);
        if (isInterface) {
          m.abstract = true;
        }
        methods.push(m);
      } else {
        const pr = this._visitProperty(p, pDecl, false);
        if (isInterface) {
          pr.abstract = true;
        }
        props.push(pr);
      }
    }

    if (!isInterface) {
      for (const sp of staticPropsForPrefetch) {
        if (sp.name === 'prototype' || this._isInternal(sp)) {
          continue;
        }
        if (this._shouldStrip(sp, `${jsiiType.fqn}#${sp.name}`)) {
          if ((sp.flags & SymbolFlags.Method) !== 0) {
            strippedMethods = true;
          } else {
            strippedProps = true;
          }
          continue;
        }
        const spDecl = sp.declarations?.[0]?.resolve(this.project);
        if (!spDecl) {
          continue;
        }
        if (spDecl.parent !== decl) {
          // Same declaring-type logic as the instance loop: statics declared on
          // an *erased* (private/internal/unexported) base are re-listed on this
          // type (strada blends erased-base declarations into the member walk);
          // statics declared on an exported/foreign named base are not.
          const ownerTypeSym = spDecl.parent ? this.checker.getTypeAtLocation(spDecl.parent)?.getSymbol?.() : undefined;
          const ownerId = ownerTypeSym?.id;
          const isOwn = ownerId != null && ownerId === sym?.id;
          if (!isOwn && !(ownerId != null && erasedBaseSymIds.has(ownerId))) {
            continue;
          }
        }
        if ((spDecl.modifiers ?? []).some((x: any) => x.kind === SyntaxKind.PrivateKeyword)) {
          continue;
        }
        if ((sp.flags & SymbolFlags.Method) !== 0) {
          methods.push(this._visitMethod(sp, spDecl, true));
        } else {
          props.push(this._visitProperty(sp, spDecl, true));
        }
      }
    }

    if (props.length || strippedProps) {
      jsiiType.properties = props.sort(compareMembers);
    }
    if (methods.length || strippedMethods) {
      jsiiType.methods = methods.sort(compareMembers);
    }
  }

  /**
   * Documentation of a class/interface member, inherited like the classic
   * services did it (`findBaseOfDeclaration`): a member without JSDoc of its own
   * takes the documentation of the same-named member of the first super type
   * (`extends` then `implements`, recursively) that documents it. The TypeScript 7
   * checker already follows base classes, but not implemented interfaces, so the
   * walk is done here when the checker returns nothing.
   */
  private _visitMemberDocumentation(msym: any, decl: any): any | undefined {
    const own = this._visitDocumentation(msym) ?? {};
    if (own.summary != null || own.remarks != null) {
      return own;
    }
    const { SyntaxKind } = this.ts;
    const seen = new Set<unknown>();
    const inherited = (typeDecl: any): any | undefined => {
      if (typeDecl == null || seen.has(typeDecl)) {
        return undefined;
      }
      seen.add(typeDecl);
      const clauses: any[] = typeDecl.heritageClauses ?? [];
      const ordered = [
        ...clauses.filter((h: any) => h.token === SyntaxKind.ExtendsKeyword),
        ...clauses.filter((h: any) => h.token !== SyntaxKind.ExtendsKeyword),
      ];
      for (const h of ordered) {
        for (const t of h.types) {
          const baseType = this.checker.getTypeAtLocation(t);
          const prop = baseType && this.checker.getPropertyOfType(baseType, msym.name);
          if (!prop) {
            continue;
          }
          const docs = this._visitDocumentation(prop);
          if (docs?.summary != null || docs?.remarks != null) {
            return docs;
          }
          const propDecl = prop.declarations?.[0]?.resolve(this.project);
          const found = inherited(propDecl?.parent);
          if (found != null) {
            return found;
          }
        }
      }
      return undefined;
    };
    // The classic compiler read the comment with inheritance (getDocumentationComment)
    // but the tags without (getJsDocTags()), so only summary/remarks are taken over.
    // A parameter property is declared in the constructor; its type is the class.
    const base = inherited(decl?.kind === SyntaxKind.Parameter ? decl.parent?.parent : decl?.parent);
    const result = {
      ...(base?.summary != null ? { summary: base.summary } : {}),
      ...(base?.remarks != null ? { remarks: base.remarks } : {}),
      ...own,
    };
    return Object.keys(result).length ? result : undefined;
  }

  private _visitMethod(msym: any, decl: any, isStatic: boolean): any {
    const { SyntaxKind } = this.ts;
    const sig = this.checker.getSignatureFromDeclaration(decl);
    const m: any = { locationInModule: this._locationOf(decl), name: msym.name };
    if (isStatic) {
      m.static = true;
    }
    const mods = decl.modifiers ?? [];
    if (mods.some((x: any) => x.kind === SyntaxKind.AbstractKeyword)) {
      m.abstract = true;
    }
    if (mods.some((x: any) => x.kind === SyntaxKind.ProtectedKeyword)) {
      m.protected = true;
    }
    if (sig) {
      const params = sig.getParameters().map((p: any) => this._visitParameter(p));
      if (params.length) {
        m.parameters = params;
      }
      if (params.some((p: any) => p.variadic)) {
        m.variadic = true;
      }
      const opt: { optional?: boolean } = {};
      let retType = this.checker.getReturnTypeOfSignature(sig);
      let retNode = decl.type;
      // Promise-returning methods: jsii marks them `async` and models the
      // resolved type (Promise<string> -> string), like strada.
      if (retType && typeof retType.isTypeReference === 'function' && retType.isTypeReference()) {
        const tsym = retType.getTarget?.()?.getSymbol?.();
        if (tsym?.name === 'Promise' && this._isStdlibDecl(tsym)) {
          m.async = true;
          retType = this.checker.getTypeArguments(retType)?.[0];
          retNode = retNode?.typeArguments?.[0];
        }
      }
      const ret = this._typeReference(retType, opt, retNode);
      if (ret) {
        m.returns = opt.optional ? { optional: true, type: ret } : { type: ret };
      }
    }
    const d = this._visitMemberDocumentation(msym, decl);
    if (d) {
      m.docs = d;
    }
    return this._withDefaultDocs(m);
  }

  private _visitProperty(psym: any, decl: any, isStatic: boolean): any {
    const { SyntaxKind } = this.ts;
    const t = this.checker.getTypeOfSymbolAtLocation(psym, decl);
    const opt: { optional?: boolean } = {};
    const p: any = {
      locationInModule: this._locationOf(decl),
      name: psym.name,
      type: this._typeReference(t, opt, decl.type),
    };
    const mods = decl.modifiers ?? [];
    const hasSetter = psym.declarations?.some((h: any) => h.kind === SyntaxKind.SetAccessor);
    if (
      mods.some((x: any) => x.kind === SyntaxKind.ReadonlyKeyword) ||
      (decl.kind === SyntaxKind.GetAccessor && !hasSetter)
    ) {
      p.immutable = true;
    }
    if (mods.some((x: any) => x.kind === SyntaxKind.ProtectedKeyword)) {
      p.protected = true;
    }
    if (mods.some((x: any) => x.kind === SyntaxKind.AbstractKeyword)) {
      p.abstract = true;
    }
    if (isStatic) {
      p.static = true;
      if (mods.some((x: any) => x.kind === SyntaxKind.ReadonlyKeyword)) {
        p.const = true;
      }
    }
    const q =
      decl.questionToken ?? (decl.postfixToken?.kind === SyntaxKind.QuestionToken ? decl.postfixToken : undefined);
    if (q != null || opt.optional) {
      p.optional = true;
    }
    const d = this._visitMemberDocumentation(psym, decl) ?? {};
    if (decl.kind === SyntaxKind.Parameter) {
      // Classic: the documentation comment of a parameter property is its own
      // JSDoc followed by the constructor's `@param <name>` text (when present).
      const paramText = this._paramDocComment(psym, decl);
      const own = this._docCommentWithClassicLinks(psym);
      const ownText = typeof own === 'string' ? own.trim() : '';
      // The TypeScript 7 checker already uses the `@param` text when the
      // parameter has no JSDoc of its own; the combination with an own comment,
      // and the fallback when the own JSDoc block only holds tags, are missing.
      if (paramText && !ownText.includes(paramText.trim())) {
        const combined = [ownText, paramText.trim()].filter(Boolean).join('\n');
        const { summary, remarks } = this._splitSummary(combined);
        delete d.remarks;
        if (remarks) {
          d.remarks = remarks;
        }
        d.summary = summary;
      }
    }
    if (Object.keys(d).length) {
      p.docs = d;
    }
    return this._withDefaultDocs(p);
  }

  private _visitParameter(prm: any): any {
    const decl = prm.declarations?.[0]?.resolve(this.project);
    const t = decl ? this.checker.getTypeOfSymbolAtLocation(prm, decl) : undefined;
    const opt: { optional?: boolean } = {};
    const p: any = { name: prm.name, type: this._typeReference(t, opt, decl?.type) };
    if (decl?.dotDotDotToken) {
      p.variadic = true;
      p.type = p.type?.collection?.elementtype ?? p.type;
    } else if (decl?.questionToken != null || decl?.initializer != null || opt.optional) {
      p.optional = true;
    }
    // Parameter docs mirror TS5's services semantics that strada relies on:
    // 1. the `@param` tag from the JSDoc of the function declaration that OWNS
    //    the parameter (never the base/overridden signature's @param — method
    //    params do NOT inherit docs);
    // 2. when a CONSTRUCTOR parameter has no own @param, TS5's
    //    findBaseOfDeclaration falls back to the documentation of a PROPERTY
    //    with the parameter's name on the first super type that has one (this
    //    is how e.g. RemoveTag's ctor param `key` gets TagBase.key's doc).
    // The tsgo checker's doc APIs implement different inheritance (methods
    // over-inherit, some @param tags are missed), so the @param text is read
    // straight from the owning declaration's JSDoc source text.
    // TS collects parameter docs from BOTH an inline JSDoc block directly on
    // the parameter declaration (common for documented parameter properties)
    // and the `@param` tag of the owning function's JSDoc; when both exist
    // they are concatenated (inline first), as strada's output shows.
    const inline = this._inlineJsDocText(decl);
    const tagText = this._paramDocComment(prm, decl);
    let comments = inline != null && tagText != null ? `${inline}\n${tagText}` : inline ?? tagText;
    if (comments === undefined && decl?.parent?.kind === this.ts.SyntaxKind.Constructor) {
      comments = this._inheritedCtorParamDoc(prm, decl);
    }
    if (comments) {
      const { summary, remarks } = this._splitSummary(comments);
      const docs: any = {};
      if (remarks) {
        docs.remarks = remarks;
      }
      if (summary) {
        docs.summary = summary;
      }
      if (Object.keys(docs).length) {
        p.docs = docs;
      }
    }
    return p;
  }

  /**
   * Extract the `@param <name>` description for a parameter from the JSDoc
   * block that immediately precedes its owning function declaration. Returns
   * undefined when the declaration has no JSDoc or no matching @param tag.
   */
  private _paramDocComment(prm: any, paramDecl: any): string | undefined {
    const funcDecl = paramDecl?.parent;
    const block = funcDecl ? this._leadingJsDocBlock(funcDecl) : undefined;
    if (!block) {
      return undefined;
    }
    const out: string[] = [];
    let capturing = false;
    let done = false;
    // A new `@tag` starts even MID-LINE in the TS JSDoc parser (e.g.
    // "...Lambda function. @see Permission for details." ends the @param text
    // before "@see"), except inside an inline `{@link ...}`.
    const cutInlineTag = (s: string): { text: string; cut: boolean } => {
      const m = /(?:^|[^{\S])@[A-Za-z]/.exec(s);
      if (!m) {
        return { text: s, cut: false };
      }
      const at = s.indexOf('@', m.index);
      return { text: s.slice(0, at).replace(/\s+$/, ''), cut: true };
    };
    for (const line of this._jsDocLines(block)) {
      if (done) {
        break;
      }
      if (capturing) {
        if (/^@/.test(line)) {
          break;
        }
        const { text, cut } = cutInlineTag(line);
        out.push(text);
        done = cut;
        continue;
      }
      // Keep the text verbatim after the parameter name (including a leading
      // `- ` separator — strada keeps it in the summary).
      // Accept `@param name`, `@param [name]` and `@param [name=default]`
      // (JSDoc optional-parameter syntax), with an optional `{type}` prefix.
      const m = /^@param\s+(?:\{[^}]*\}\s+)?(?:\[([\w$]+)(?:=[^\]]*)?\]|([\w$]+))\s*(.*)$/.exec(line);
      if (m && (m[1] ?? m[2]) === prm.name) {
        capturing = true;
        const { text, cut } = cutInlineTag(m[3]);
        out.push(text);
        done = cut;
      }
    }
    if (!capturing) {
      return undefined;
    }
    const result = out.join('\n').trim();
    return result === '' ? undefined : result;
  }

  /** Source text of a declaration's file (client-side cache; no RPC). */
  private _sourceTextOf(sf: any): string {
    if (typeof sf?.text === 'string') {
      return sf.text;
    }
    let text = this._sourceTextCache.get(sf?.fileName);
    if (text === undefined) {
      try {
        text = fs.readFileSync(sf.fileName, 'utf8');
      } catch {
        text = '';
      }
      this._sourceTextCache.set(sf.fileName, text);
    }
    return text;
  }

  /** The last JSDoc block in a node's leading trivia, or undefined. */
  private _leadingJsDocBlock(node: any): string | undefined {
    const sf = node?.getSourceFile?.();
    if (!sf) {
      return undefined;
    }
    const text = this._sourceTextOf(sf);
    if (!text) {
      return undefined;
    }
    const leading = text.slice(node.pos, node.getStart(sf));
    const blocks = leading.match(/\/\*\*[\s\S]*?\*\//g);
    return blocks && blocks.length ? blocks[blocks.length - 1] : undefined;
  }

  /** Margin-stripped lines of a JSDoc block. */
  private _jsDocLines(block: string): string[] {
    return block
      .replace(/^\/\*\*/, '')
      .replace(/\*\/$/, '')
      .split('\n')
      .map((l) => l.replace(/^\s*\*?\s*/, '').replace(/\s+$/, ''));
  }

  /** Full text of an inline JSDoc block attached to a declaration, or undefined. */
  private _inlineJsDocText(decl: any): string | undefined {
    const block = decl ? this._leadingJsDocBlock(decl) : undefined;
    if (!block) {
      return undefined;
    }
    const textLines: string[] = [];
    for (const line of this._jsDocLines(block)) {
      if (/^@/.test(line)) {
        break;
      }
      textLines.push(line);
    }
    const result = textLines.join('\n').trim();
    return result === '' ? undefined : result;
  }

  /**
   * Build a jsii docs object from a declaration's leading JSDoc, mirroring what
   * `_visitDocumentation` produces from the symbol doc APIs (summary/remarks +
   * the doc tags jsii consumes). Used for constructor (initializer) docs, where
   * no symbol-level doc read exists on the ts path.
   */
  private _docsFromDeclJsDoc(decl: any): any | undefined {
    const block = this._leadingJsDocBlock(decl);
    if (!block) {
      return undefined;
    }
    const lines = this._jsDocLines(block);
    const commentLines: string[] = [];
    const tags: Array<{ name: string; text: string }> = [];
    let current: { name: string; text: string[] } | undefined;
    for (const line of lines) {
      const tm = /^@([A-Za-z][\w-]*)\s*(.*)$/.exec(line);
      if (tm) {
        if (current) {
          tags.push({ name: current.name, text: current.text.join('\n') });
        }
        current = { name: tm[1], text: [tm[2]] };
      } else if (current) {
        current.text.push(line);
      } else {
        commentLines.push(line);
      }
    }
    if (current) {
      tags.push({ name: current.name, text: current.text.join('\n') });
    }
    const docs: any = {};
    const comment = commentLines.join('\n').trim();
    if (comment) {
      const { summary, remarks } = this._splitSummary(comment);
      if (remarks) {
        docs.remarks = remarks;
      }
      docs.summary = summary;
    }
    for (const tag of tags) {
      const tagText = renderTagLinks(tag.text);
      switch (tag.name) {
        case 'default':
          docs.default = tagText.trim();
          break;
        case 'deprecated':
          docs.deprecated = tagText.trim();
          docs.stability = 'deprecated';
          break;
        case 'stability':
          docs.stability = tagText.trim();
          break;
        case 'example':
          docs.example = tagText.replace(/^\n/, '');
          break;
        case 'returns':
          docs.returns = tagText.trim();
          break;
        case 'see':
          docs.see = tagText.trim();
          break;
        default:
          break;
      }
    }
    return Object.keys(docs).length ? docs : undefined;
  }

  /**
   * TS5 `findBaseOfDeclaration` fallback for constructor parameters: the first
   * super type (extends/implements, in source order) that has a PROPERTY named
   * like the parameter contributes that property's documentation; the search
   * stops at the first super type owning such a property even when its docs
   * are empty. Method parameters have no such fallback.
   */
  private _inheritedCtorParamDoc(prm: any, paramDecl: any): string | undefined {
    return this._inheritedPropDocFromBases(paramDecl.parent?.parent, prm.name, new Set());
  }

  /**
   * TS5 `findBaseOfDeclaration` search: the first super type (extends /
   * implements, in source order) of a class/interface declaration that has a
   * property with the given name contributes that property's documentation —
   * even when empty (the search stops there). Doc resolution for the found
   * property is itself recursive: a class element with no own JSDoc inherits
   * from ITS super types (e.g. a getter overriding an interface property).
   */
  private _inheritedPropDocFromBases(classOrIfaceDecl: any, name: string, seen: Set<string>): string | undefined {
    for (const h of classOrIfaceDecl?.heritageClauses ?? []) {
      for (const t of h.types ?? []) {
        const s = this._heritageBaseSymbol(t);
        const baseDecl = s?.declarations?.[0]?.resolve(this.project);
        const baseType = baseDecl ? this.checker.getTypeAtLocation(baseDecl) : undefined;
        const psym = baseType ? this.checker.getPropertyOfType(baseType, name) : undefined;
        if (psym) {
          return this._symbolDocTextFromSource(psym, seen);
        }
      }
    }
    return undefined;
  }

  /**
   * Documentation text of a member symbol, read from source (the tsgo doc APIs
   * return an empty comment for several of these members — one of the JSDoc
   * behaviour gaps this backend works around). A constructor parameter
   * property's docs come from an inline JSDoc on the parameter or the
   * constructor's `@param` tag; other members use their leading JSDoc. Empty
   * own docs recurse into the owner's super types.
   */
  private _symbolDocTextFromSource(psym: any, seen: Set<string>): string | undefined {
    const { SyntaxKind } = this.ts;
    const d0 = psym.declarations?.[0];
    const key = `${d0?.path}:${d0?.index}`;
    if (!d0 || seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    const pd = d0.resolve(this.project);
    if (!pd) {
      return undefined;
    }
    const own =
      pd.kind === SyntaxKind.Parameter
        ? this._inlineJsDocText(pd) ?? this._paramDocComment(psym, pd)
        : this._inlineJsDocText(pd);
    if (own !== undefined) {
      return own;
    }
    const owner = pd.parent?.kind === SyntaxKind.Constructor ? pd.parent.parent : pd.parent;
    return this._inheritedPropDocFromBases(owner, psym.name, seen);
  }

  // -------------------------------------------------------------------------
  // type references (strada: _typeReference / _optionalValue)
  // -------------------------------------------------------------------------

  private _unionNodeOf(typeNode: any): any {
    const { SyntaxKind } = this.ts;
    if (!typeNode) {
      return undefined;
    }
    if (typeNode.kind === SyntaxKind.UnionType) {
      return typeNode;
    }
    if (typeNode.kind === SyntaxKind.TypeReference) {
      const s0 = this._symbolAtNodeSafe(typeNode.typeName) ?? this._aliasSymbolAt(typeNode);
      const s = s0 ? this._resolveAlias(s0) : undefined;
      const d = s?.declarations?.[0]?.resolve(this.project);
      if (d?.kind === SyntaxKind.TypeAliasDeclaration && d.type?.kind === SyntaxKind.UnionType) {
        return d.type;
      }
    }
    return undefined;
  }

  /**
   * Client-side array-type check to avoid an out-of-process `checker.isArrayType`
   * RPC on every type reference (~85k on aws-cdk-lib). `type.isTypeReference()`
   * is a local objectFlags bit; the target's symbol name (`Array`/`ReadonlyArray`
   * from a `lib.*.d.ts`) is resolved client-side after the global Array type is
   * fetched once. Verified to produce identical `.jsii` vs `checker.isArrayType`.
   */
  private _isArrayType(type: any): boolean {
    if (typeof type.isTypeReference !== 'function' || !type.isTypeReference()) {
      return false;
    }
    const target = type.getTarget?.() ?? type;
    const tsym = target?.getSymbol?.();
    const name = tsym?.name;
    if (name !== 'Array' && name !== 'ReadonlyArray') {
      return false;
    }
    // must be the built-in Array from the standard library (not a user type)
    return this._isStdlibDecl(tsym);
  }

  /** Whether the symbol's first declaration lives in a standard-library lib.*.d.ts. */
  private _isStdlibDecl(sym: any): boolean {
    return isStdlibDeclPath(sym?.declarations?.[0]?.path ?? '');
  }

  private _typeReference(type: any, optionalOut?: { optional?: boolean }, typeNode?: any): any {
    const { TypeFlags } = this.ts;
    if (!type) {
      return { primitive: 'any' };
    }
    const f = type.flags;
    if (f & TypeFlags.EnumLike) {
      const s = type.getSymbol();
      const parent = s?.getParent();
      const fqn =
        s &&
        (this.typeFqnBySymbolId.get(s.id) ??
          this._externalFqnOf(s) ??
          (parent && (this.typeFqnBySymbolId.get(parent.id) ?? this._externalFqnOf(parent))));
      if (fqn) {
        return { fqn };
      }
    }
    if (f & TypeFlags.NonPrimitive) {
      return { primitive: 'json' };
    }
    if (f & TypeFlags.StringLike) {
      return { primitive: 'string' };
    }
    if (f & TypeFlags.NumberLike) {
      return { primitive: 'number' };
    }
    if (f & TypeFlags.BooleanLike) {
      return { primitive: 'boolean' };
    }
    if (f & (TypeFlags.Any | TypeFlags.Unknown)) {
      return { primitive: 'any' };
    }
    if (f & TypeFlags.Void) {
      return undefined;
    }
    if (type.isUnionType()) {
      return this._unionTypeReference(type, optionalOut, typeNode);
    }
    if (typeof type.isIntersectionType === 'function' && type.isIntersectionType()) {
      return this._intersectionTypeReference(type);
    }
    if (this._isArrayType(type)) {
      const args = type.isTypeReference() ? this.checker.getTypeArguments(type) : [];
      return { collection: { elementtype: this._typeReference(args[0]), kind: 'array' } };
    }
    const sym = type.getSymbol();
    // Boxed standard-library wrapper types map to primitives (strada's
    // _tryMakePrimitiveType): e.g. `limit?: Number` or `Array<String>`.
    if (sym && this._isStdlibDecl(sym)) {
      switch (sym.name) {
        case 'Boolean':
          return { primitive: 'boolean' };
        case 'Date':
          return { primitive: 'date' };
        case 'Number':
          return { primitive: 'number' };
        case 'String':
          return { primitive: 'string' };
        default:
          break;
      }
    }
    if (sym) {
      const target = type.isTypeReference() ? type.getTarget() : type;
      const tsym = target.getSymbol() ?? sym;
      const fqn = this.typeFqnBySymbolId.get(tsym.id) ?? this._externalFqnOf(tsym);
      if (fqn) {
        return { fqn };
      }
    }
    const indexInfos = this.checker.getIndexInfosOfType(type);
    if (indexInfos.length) {
      return { collection: { elementtype: this._typeReference(indexInfos[0].valueType), kind: 'map' } };
    }
    return { primitive: 'any' };
  }

  private _unionTypeReference(type: any, optionalOut?: { optional?: boolean }, typeNode?: any): any {
    const { TypeFlags } = this.ts;
    const all = type.getTypes();
    const parts = all.filter((t: any) => !(t.flags & (TypeFlags.Undefined | TypeFlags.Null)));
    if (optionalOut && parts.length !== all.length) {
      optionalOut.optional = true;
    }
    const un = this._unionNodeOf(typeNode);
    if (un) {
      const refs: any[] = [];
      const seen = new Set<string>();
      const pushFlat = (r: any): void => {
        if (!r) {
          return;
        }
        if (r.union) {
          for (const inner of r.union.types) {
            pushFlat(inner);
          }
          return;
        }
        const key = JSON.stringify(r);
        if (!seen.has(key)) {
          seen.add(key);
          refs.push(r);
        }
      };
      for (const tn of un.types) {
        const tt = this.checker.getTypeFromTypeNode(tn);
        if (tt && tt.flags & (TypeFlags.Undefined | TypeFlags.Null)) {
          if (optionalOut) {
            optionalOut.optional = true;
          }
          continue;
        }
        pushFlat(this._typeReference(tt, optionalOut, tn));
      }
      if (refs.length === 1) {
        return refs[0];
      }
      if (refs.length > 1) {
        return { union: { types: sortUnionLikeClassic(refs, (fqn) => this._declarationRank(fqn)) } };
      }
    }
    const refs: any[] = [];
    const seen = new Set<string>();
    for (const p of parts) {
      const r = this._typeReference(p, optionalOut);
      const key = JSON.stringify(r);
      if (r && !seen.has(key)) {
        seen.add(key);
        refs.push(r);
      }
    }
    if (refs.length === 1) {
      return refs[0];
    }
    return { union: { types: sortUnionLikeClassic(refs, (fqn) => this._declarationRank(fqn)) } };
  }

  /**
   * Build an intersection type reference (`A & B`), e.g. jsii models
   * `IFooRef & IGrantable` as `{ intersection: { types: [...] } }`. Mirrors
   * strada's `type.isIntersection()` branch: each constituent is turned into a
   * type reference, deduplicated.
   */
  private _intersectionTypeReference(type: any): any {
    const refs: any[] = [];
    const seen = new Set<string>();
    for (const t of type.getTypes()) {
      const r = this._typeReference(t);
      if (!r) {
        continue;
      }
      const key = JSON.stringify(r);
      if (!seen.has(key)) {
        seen.add(key);
        refs.push(r);
      }
    }
    if (refs.length === 1) {
      return refs[0];
    }
    this.usedFeatures.add('intersection-types');
    return { intersection: { types: refs } };
  }

  // -------------------------------------------------------------------------
  // documentation (strada: _visitDocumentation)
  // -------------------------------------------------------------------------

  private _visitDocumentation(sym: any): any | undefined {
    const summaryRaw = this._docCommentWithClassicLinks(sym);
    const docs: any = {};
    if (summaryRaw) {
      const text = typeof summaryRaw === 'string' ? summaryRaw.trim() : String(summaryRaw).trim();
      const { summary, remarks } = this._splitSummary(text);
      if (remarks) {
        docs.remarks = remarks;
      }
      docs.summary = summary;
    }
    // Exact port of jsii's parseDocParts (src/docs.ts of the classic compiler):
    // every tag is collected once, well-known tags are consumed into their
    // dedicated fields (with the same aliases and precedence), and whatever is
    // left over becomes `docs.custom`. `@param` is handled with the parameter
    // itself and `@jsii` is internal-only; neither surfaces in the API docs.
    const tagValues = new Map<string, string>();
    for (const tag of this._jsDocTags(sym)) {
      if (tag.name === 'param' || tag.name === 'jsii') {
        continue;
      }
      let tagText = renderTagLinks(
        typeof tag.text === 'string' ? tag.text : (tag.text ?? []).map((p: any) => p.text).join(''),
      );
      if (tag.name === 'see' && /^[^\s$A-Za-z_{]/.test(tagText)) {
        // The classic parser read a name reference first when `@see` starts with an
        // identifier; otherwise the text came back as [text(''), space, text], i.e.
        // with a leading space.
        tagText = ` ${tagText}`;
      } else if (tag.name === 'enum') {
        // The classic parser consumed the type expression of `@enum {T}`.
        tagText = tagText.replace(/^\{[^}]*\}\s*/, '');
      }
      tagValues.set(tag.name, tagText);
    }
    const eatTag = (...names: string[]): string | undefined => {
      for (const name of names) {
        if (tagValues.has(name)) {
          const value = tagValues.get(name);
          tagValues.delete(name);
          return value ?? '';
        }
      }
      return undefined;
    };
    const setIfDefined = (key: string, value: string | undefined, transform: (v: string) => string = (v) => v) => {
      if (value !== undefined) {
        docs[key] = transform(value);
      }
    };

    eatTag('struct'); // a type-system hint, consumed by the datatype detection, not documentation
    setIfDefined('default', eatTag('default', 'defaultValue'));
    const deprecated = eatTag('deprecated');
    setIfDefined('deprecated', deprecated);
    setIfDefined('example', eatTag('example'));
    setIfDefined('returns', eatTag('returns', 'return'));
    setIfDefined('see', eatTag('see'));
    if (eatTag('subclassable') !== undefined) {
      docs.subclassable = true;
    }
    setIfDefined('stability', eatTag('stability'));
    // @experimental and @stable are shorthands for the matching @stability
    const experimental = eatTag('experimental') !== undefined;
    const stable = eatTag('stable') !== undefined;
    if (experimental) {
      docs.stability = 'experimental';
    }
    if (stable) {
      docs.stability = 'stable';
    }
    if (deprecated !== undefined) {
      docs.stability = 'deprecated';
    }
    if (tagValues.size > 0) {
      docs.custom = {};
      for (const [key, value] of tagValues.entries()) {
        // Key must have a value or it will be stripped from the assembly
        docs.custom[key] = value === '' ? 'true' : value;
      }
    }
    return Object.keys(docs).length ? docs : undefined;
  }

  // Exact port of jsii's summary/remarks split (src/docs.ts splitSummary /
  // summaryLine / endWithPeriod / noNewlines / uberTrim); the regex constants
  // are declared at the top of the class (member-ordering).
  private _splitSummary(docBlock: string): { summary?: string; remarks?: string } {
    return splitSummary(docBlock);
  }

  private _withDefaultDocs(obj: any): any {
    if (!this.currentStability) {
      return obj;
    }
    if (!obj.docs) {
      obj.docs = { stability: this.currentStability };
    } else if (!obj.docs.stability) {
      obj.docs.stability = this.currentStability;
    }
    return obj;
  }

  private _locationOf(decl: any): spec.SourceLocation {
    const sf = decl.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(decl.getStart(sf));
    return { filename: path.relative(this.root, sf.fileName), line: line + 1 };
  }

  // -------------------------------------------------------------------------
  // assembly header assembly (strada: emit() tail)
  // -------------------------------------------------------------------------

  private _buildAssembly(): spec.Assembly {
    const info = this.options.projectInfo;
    // Same header the classic Assembler produces (its emit() tail), sourced from
    const jsiiVersion = info.jsiiVersionFormat === 'short' ? SHORT_VERSION : VERSION;

    const docs =
      info.stability || info.deprecated
        ? {
            ...(info.deprecated ? { deprecated: info.deprecated } : {}),
            ...(info.stability ? { stability: info.stability } : {}),
          }
        : undefined;

    const assembly: any = {
      schema: spec.SchemaVersion.LATEST,
      name: this.assemblyName,
      version: info.version,
      description: info.description ?? this.assemblyName,
      license: info.license,
      keywords: info.keywords && Array.from(info.keywords),
      homepage: info.homepage ?? info.repository.url,
      author: info.author,
      contributors: info.contributors && [...info.contributors],
      repository: info.repository,
      dependencies: noEmptyDict({ ...info.dependencies, ...info.peerDependencies }),
      dependencyClosure: noEmptyDict(toDependencyClosure(info.dependencyClosure)),
      bundled: info.bundleDependencies,
      types: this.types,
      ...(Object.keys(this.submodules).length ? { submodules: this.submodules } : {}),
      usedFeatures: this._finalizeInheritance(),
      targets: info.targets as spec.Assembly['targets'],
      metadata: {
        ...info.metadata,
        // Downstream consumers need these to map a symbolId in the outDir to a
        // symbolId in the rootDir (same as the classic backend records).
        // rootDir/outDir may be absolute (just like for tsc); they are normalized
        // to be relative to the package root so no absolute path leaks into the
        // assembly and breaks the reproducibility check of downstream consumers.
        ...(this.options.tscRootDir != null
          ? { tscRootDir: normalizeConfigPath(this.options.projectRoot, this.options.tscRootDir) }
          : {}),
        ...(this.options.tscOutDir != null
          ? { tscOutDir: normalizeConfigPath(this.options.projectRoot, this.options.tscOutDir) }
          : {}),
      },
      ...(docs ? { docs } : {}),
      ...(this.options.readme ? { readme: this.options.readme } : {}),
      jsiiVersion,
      bin: info.bin,
    };
    return assembly as spec.Assembly;
  }
}

/** Port of the classic Assembler's `noEmptyDict`. */
function noEmptyDict<T extends Record<string, unknown>>(xs: T): T | undefined {
  return Object.keys(xs).length === 0 ? undefined : xs;
}

/**
 * Port of the classic Assembler's `toDependencyClosure`: keep only `targets`
 * and slimmed-down `submodules` (readme / locationInModule stripped) for each
 * assembly in the closure.
 */
function toDependencyClosure(assemblies: readonly spec.Assembly[]): Record<string, spec.DependencyConfiguration> {
  const result: Record<string, spec.DependencyConfiguration> = {};
  for (const assembly of assemblies) {
    if (!assembly.targets) {
      continue;
    }
    const submodules =
      assembly.submodules &&
      Object.fromEntries(Object.entries(assembly.submodules).map(([fqn, { targets }]) => [fqn, { targets }]));
    result[assembly.name] = { submodules, targets: assembly.targets };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Port of the classic Assembler's `isInterfaceName`: a name denotes a
 * behavioral interface when it starts with `I` and the second character is
 * uppercase (so `IonicColumnProps` is not treated as one).
 */
export function isInterfaceName(name: string): boolean {
  return name.length >= 2 && name.startsWith('I') && name.charAt(1).toUpperCase() === name.charAt(1);
}

/** Whether a declaration path points into a TypeScript standard-library `lib.*.d.ts`. */
export function isStdlibDeclPath(declPath: string): boolean {
  return /(^|\/)lib\.[^/]+\.d\.ts$/.test(declPath);
}

// Exact port of jsii's summary/remarks split (src/docs.ts splitSummary /
// summaryLine / endWithPeriod): the sentence regex requires whitespace after
// the punctuation, and ';' counts as terminal punctuation, so
// "the resource type;\nex: ..." splits into summary + remarks.
const PUNCTUATION = ['!', '?', '.', ';'].map((s) => `\\${s}`).join('');
const ENDS_WITH_PUNCTUATION_REGEX = new RegExp(`[${PUNCTUATION}]$`);
const FIRST_SENTENCE_REGEX = new RegExp(`^([^${PUNCTUATION}]+[${PUNCTUATION}][ \\n\\r])`);
const SUMMARY_MAX_WORDS = 20;

/** Split a doc comment block into the summary sentence and the remaining remarks. */
export function splitSummary(docBlock: string): { summary?: string; remarks?: string } {
  if (!docBlock) {
    return {};
  }
  const summary = summaryLine(docBlock);
  const rest = docBlock.slice(summary.length).trim();
  const s = summary.trim().replace(/\r?\n/g, ' ');
  return {
    summary: ENDS_WITH_PUNCTUATION_REGEX.test(s) ? s : `${s}.`,
    remarks: rest === '' ? undefined : rest,
  };
}

function summaryLine(str: string): string {
  const paras = str.split(/(\r?\n){2}/);
  if (paras.length > 1 && paras[0].split(' ').length < SUMMARY_MAX_WORDS) {
    return paras[0];
  }
  const m = FIRST_SENTENCE_REGEX.exec(str);
  return m ? m[1] : paras[0];
}
