/*
 * ===========================================================================
 * Experimental TypeScript 7 (tsgo) backend for jsii.
 *
 * WHAT THIS IS
 *   A TypeScript-7-native reimplementation of the jsii Assembler that reads the
 *   out-of-process TS7 API (`@typescript/native-preview`) directly and produces
 *   a `spec.Assembly` (`.jsii`). It is a structured port of a validated
 *   feasibility prototype that reproduced real `.jsii` output on aws-cdk-lib
 *   (~21k types); the current backend reaches 100% type/member parity there.
 *
 * WHY A SEPARATE ASSEMBLER (and not a facade over the classic Assembler)
 *   The classic Assembler (src/assembler.ts, ~3500 lines) is tightly coupled to
 *   the in-process `ts.Program`/`ts.TypeChecker` object model. Faking those
 *   shapes over the TS7 API would break `node-bindings` WeakMap identity and be
 *   only partially correct. The goal of this experimental phase is to PROVE
 *   `.jsii` parity on the TS7 API as fast and reliably as possible; a directed
 *   TS7-native port achieves that with zero regression risk to the default
 *   path. Whether/how to unify the two assemblers is a follow-up decision to be
 *   made from parity data. To keep that comparison tractable, this file mirrors
 *   the classic Assembler's structure and method names (`_visitClass`,
 *   `_visitInterface`, `_visitEnum`, `_visitMethod`, `_visitProperty`,
 *   `_visitDocumentation`).
 *
 * SCOPE
 *   Normal-path parity only. jsii's own DIAGNOSTICS (the JSII_xxxx
 *   error/warning suite manufactured by src/jsii-diagnostic.ts) are not
 *   produced by this backend; TypeScript compilation errors ARE surfaced (see
 *   ts7/index.ts).
 * ===========================================================================
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as spec from '@jsii/spec';

import type { ProjectInfo } from '../project-info';
import { SHORT_VERSION, VERSION } from '../version';
import { NativePreview } from './native-preview';
import { Ts7Project } from './ts7-host';

export interface Ts7AssemblerOptions {
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
}

interface RegisteredType {
  readonly name: string;
  readonly sym: any;
  readonly decl: any;
  readonly fqn: string;
}

/**
 * Reproduces the subset of jsii's assembly generation needed for normal-path
 * `.jsii` parity, over the TS7 API.
 */
export class Ts7Assembler {
  private readonly np: NativePreview;
  private readonly checker: any;
  private readonly program: any;
  private readonly project: Ts7Project;

  private readonly root: string;
  private readonly assemblyName: string;
  private readonly entry: string;
  private readonly defaultStability?: spec.Stability;
  private currentStability?: spec.Stability;

  private readonly types: Record<string, spec.Type> = {};
  private readonly submodules: Record<string, unknown> = {};
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

  // external dependency assemblies (peerDependencies): name -> Set(type names)
  private readonly externalDeps = new Map<string, Set<string>>();
  // full type records of external dependency assemblies, keyed by fqn (for
  // datatype propagation across assembly boundaries)
  private readonly externalTypeByFqn = new Map<string, any>();
  private readonly stripDeprecated: boolean;
  private stripAllowList?: Set<string>;
  // Type symbols dropped by --strip-deprecated. Unlike genuinely unexported
  // (erased) bases, a stripped base is a *named* type that strada's
  // DeprecatedRemover deletes post-assembly WITHOUT folding its members into
  // subclasses — so member re-listing must not treat it as an erased base.
  private readonly strippedTypeSymIds = new Set<unknown>();

  public constructor(np: NativePreview, project: Ts7Project, private readonly options: Ts7AssemblerOptions) {
    this.np = np;
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
      throw new Error(`ts7: entrypoint not found: ${this.entry}`);
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
    const { SymbolFlags } = this.np;
    let s = sym;
    while ((s.flags & SymbolFlags.Alias) !== 0) {
      s = this.checker.getAliasedSymbol(s);
    }
    return s;
  }

  private _isInternal(sym: any): boolean {
    return this._jsDocTags(sym).some((t: any) => t.name === 'internal') || sym.name.startsWith('_');
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
   * Batch-prefetch JSDoc tags + doc comments for many symbols in one RPC
   * (getSymbolDocumentations, when the toolchain provides it), filling the same caches that
   * _jsDocTags/_docComment consult. Per-element results are exactly what the
   * individual calls would return, so behaviour is unchanged — only the number
   * of round-trips drops (~302k doc RPCs -> ~1 per type on aws-cdk-lib).
   * No-ops gracefully when the toolchain lacks the batched endpoint.
   */
  private _prefetchDocs(syms: any[]): void {
    if (typeof this.checker.getSymbolDocumentations !== 'function') {
      return;
    }
    const wanted: any[] = [];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const sym of syms) {
      if (!sym) {
        continue;
      }
      const key = this._symbolDocKey(sym);
      if (!key || seen.has(key) || (this._jsDocTagsCache.has(key) && this._docCommentCache.has(key))) {
        continue;
      }
      seen.add(key);
      wanted.push(sym);
      keys.push(key);
    }
    // Chunked so a single request stays well under the RPC message-size sweet
    // spot observed during measurement (larger chunks saved no time).
    const CHUNK = 1000;
    for (let i = 0; i < wanted.length; i += CHUNK) {
      const chunk = wanted.slice(i, i + CHUNK);
      const docs = this.checker.getSymbolDocumentations(chunk);
      for (let j = 0; j < chunk.length; j++) {
        const key = keys[i + j];
        const d = docs[j] ?? { tags: [], comment: '' };
        this._jsDocTagsCache.set(key, d.tags ?? []);
        this._docCommentCache.set(key, (d.comment ?? '') === '' ? null : d.comment);
      }
    }
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
        const req = createRequire(path.join(this.root, 'package.json'));
        const depDir = path.dirname(req.resolve(`${dep}/package.json`));
        let depJsii = JSON.parse(fs.readFileSync(path.join(depDir, '.jsii'), 'utf8'));
        if (depJsii.schema === 'jsii/file-redirect') {
          depJsii = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(depDir, depJsii.filename))).toString('utf8'));
        }
        this.externalDeps.set(
          dep,
          new Set(Object.keys(depJsii.types ?? {}).map((f) => f.slice(depJsii.name.length + 1))),
        );
        for (const [fqn, type] of Object.entries(depJsii.types ?? {})) {
          this.externalTypeByFqn.set(fqn, type);
        }
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

  private _externalFqnOf(sym: any): string | undefined {
    const decl0 = sym.declarations?.[0];
    if (!decl0) {
      return undefined;
    }
    const file = decl0.path ?? '';
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file);
    if (!m) {
      return undefined;
    }
    const dep = m[1];
    if (!this.externalDeps.has(dep)) {
      return undefined;
    }
    if (this.externalDeps.get(dep)!.has(sym.name)) {
      return `${dep}.${sym.name}`;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // module walk + type registration (strada: _registerNamespaces / _visitNode)
  // -------------------------------------------------------------------------

  private _registerModuleExports(moduleExports: any[]): void {
    const { SyntaxKind, SymbolFlags } = this.np;
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
          const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(declH.path ?? '');
          if (nm && this.externalDeps.has(nm[1])) {
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
          const subFqn = `${prefix}.${e.name}`;
          const key = `${sym.id}:${subFqn}`;
          if (visitedModules.has(key)) {
            continue;
          }
          visitedModules.add(key);
          if (prefix === this.assemblyName) {
            this.submodules[subFqn] = {};
          }
          const subDir = path.dirname(sym.declarations?.[0]?.path ?? moduleDir);
          collect(this.checker.getExportsOfModule(sym), subFqn, subDir);
        }
      }
    };
    collect(moduleExports, this.assemblyName, path.dirname(this.entry));

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
    const { SyntaxKind } = this.np;
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

  private _symbolIdOf(sym: any): string | undefined {
    // NOTE: unlike the classic backend's symbolIdentifier, this does not remap
    // the path through tscRootDir/tscOutDir. All verified packages use layouts
    // where the source path IS the symbolId path (in-place or src==rootDir);
    // out-of-source layouts that need the remap are a known limitation.
    const tsFqn = this.checker.getFullyQualifiedName(sym); // e.g. "/abs/path/src/construct".Construct
    const m = /^"([^"]+)"(?:\.(.*))?$/.exec(tsFqn);
    if (!m) {
      return undefined;
    }
    let rel: string;
    const nm = m[1].lastIndexOf('node_modules/');
    if (nm >= 0) {
      const after = m[1].slice(nm + 'node_modules/'.length);
      rel = after
        .split('/')
        .slice(after.startsWith('@') ? 2 : 1)
        .join('/');
    } else {
      rel = path.relative(this.root, m[1]);
    }
    return `${rel}:${m[2] ?? ''}`;
  }

  // -------------------------------------------------------------------------
  // per-type dispatch (strada: _visitNode)
  // -------------------------------------------------------------------------

  private _visitNode(name: string, sym: any, decl: any, fqn: string): void {
    const { SyntaxKind } = this.np;
    const jsiiType: any = {
      assembly: this.assemblyName,
      fqn,
      kind: '',
      locationInModule: this._locationOf(decl),
      name,
    };
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
    const { SyntaxKind } = this.np;
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
      jsiiType.interfaces = interfaces;
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
    const { SyntaxKind } = this.np;
    jsiiType.kind = 'class';
    const mods = decl.modifiers ?? [];
    if (mods.some((x: any) => x.kind === SyntaxKind.AbstractKeyword)) {
      jsiiType.abstract = true;
    }

    // heritage (base class + implemented interfaces), flattening erased/local bases
    const base: { value?: string } = {};
    const interfaces = new Set<string>();
    const erasedClassBases: any[] = [];
    const collectHeritage = (classDecl: any): void => {
      for (const h of classDecl.heritageClauses ?? []) {
        const isExt = h.token === SyntaxKind.ExtendsKeyword;
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
                erasedClassBases.push({ getSymbol: () => s, symbol: s });
                collectHeritage(d0);
              }
            }
          } else if (fqnRef) {
            interfaces.add(fqnRef);
          } else {
            const d0 = s.declarations?.[0]?.resolve(this.project);
            if (d0 && d0.kind === SyntaxKind.InterfaceDeclaration) {
              erasedClassBases.push({ getSymbol: () => s, symbol: s });
              collectHeritage(d0);
            }
          }
        }
      }
    };
    collectHeritage(decl);
    if (base.value) {
      jsiiType.base = base.value;
    }
    if (interfaces.size) {
      jsiiType.interfaces = [...interfaces];
    }

    // initializer (constructor)
    const ctor = decl.members?.find((m: any) => m.kind === SyntaxKind.Constructor);
    // If the class does not declare its own constructor, jsii uses the effective
    // (inherited) constructor from the nearest base class that declares one.
    const effectiveCtor = ctor ?? this._inheritedConstructor(decl);
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
      const ctorDocs = this._docsFromDeclJsDoc(effectiveCtor);
      if (ctorDocs) {
        initializer.docs = ctorDocs;
      }
      jsiiType.initializer = this._withDefaultDocs(initializer);
    } else {
      const init: any = {};
      if (this.defaultStability) {
        init.docs = { stability: this.defaultStability };
      }
      jsiiType.initializer = init;
    }

    this._visitMembers(sym, decl, jsiiType, false, erasedClassBases);
  }

  /**
   * Walk the `extends` chain of a class declaration to find the nearest base
   * class that declares a constructor, returning that constructor declaration
   * (or undefined). Reproduces the effective/inherited initializer jsii records
   * for a subclass that does not declare its own constructor.
   */
  private _inheritedConstructor(decl: any): any | undefined {
    const { SyntaxKind } = this.np;
    let current = decl;
    const guard = new Set<any>();
    while (current) {
      if (guard.has(current)) {
        return undefined;
      }
      guard.add(current);
      let nextBase: any;
      for (const h of current.heritageClauses ?? []) {
        if (h.token !== SyntaxKind.ExtendsKeyword) {
          continue;
        }
        const t = h.types?.[0];
        if (!t) {
          continue;
        }
        const s = this._heritageBaseSymbol(t);
        const baseDecl = s?.declarations?.[0]?.resolve(this.project);
        if (baseDecl && baseDecl.kind === SyntaxKind.ClassDeclaration) {
          nextBase = baseDecl;
        }
      }
      if (!nextBase) {
        return undefined;
      }
      const baseCtor = nextBase.members?.find((m: any) => m.kind === SyntaxKind.Constructor);
      if (baseCtor) {
        return baseCtor;
      }
      current = nextBase;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // members (strada: _visitProperty / _visitMethod live under this)
  // -------------------------------------------------------------------------

  private _visitMembers(sym: any, decl: any, jsiiType: any, isInterface: boolean, erasedBases: any[] = []): void {
    const { SyntaxKind, SymbolFlags } = this.np;
    const type = this.checker.getTypeAtLocation(decl);
    const props: any[] = [];
    const methods: any[] = [];

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
      if (this._shouldStrip(p, `${jsiiType.fqn}#${p.name}`)) {
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

    if (props.length) {
      jsiiType.properties = props.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (methods.length) {
      jsiiType.methods = methods.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  private _visitMethod(msym: any, decl: any, isStatic: boolean): any {
    const { SyntaxKind } = this.np;
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
    const d = this._visitDocumentation(msym);
    if (d) {
      m.docs = d;
    }
    return this._withDefaultDocs(m);
  }

  private _visitProperty(psym: any, decl: any, isStatic: boolean): any {
    const { SyntaxKind } = this.np;
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
    const d = this._visitDocumentation(psym);
    if (d) {
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
    if (comments === undefined && decl?.parent?.kind === this.np.SyntaxKind.Constructor) {
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
   * no symbol-level doc read exists on the ts7 path.
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
      const tagText = tag.text.replace(/\{@link\s+([^}]*?)\s*\}/g, '{@link $1 }');
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
    const { SyntaxKind } = this.np;
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
    const { SyntaxKind } = this.np;
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
    const { TypeFlags } = this.np;
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
    const { TypeFlags } = this.np;
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
        return { union: { types: refs } };
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
    return { union: { types: refs } };
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
    return { intersection: { types: refs } };
  }

  // -------------------------------------------------------------------------
  // documentation (strada: _visitDocumentation)
  // -------------------------------------------------------------------------

  private _visitDocumentation(sym: any): any | undefined {
    const summaryRaw = this._docComment(sym);
    const docs: any = {};
    if (summaryRaw) {
      const text = typeof summaryRaw === 'string' ? summaryRaw.trim() : String(summaryRaw).trim();
      const { summary, remarks } = this._splitSummary(text);
      if (remarks) {
        docs.remarks = remarks;
      }
      docs.summary = summary;
    }
    for (const tag of this._jsDocTags(sym)) {
      let tagText = typeof tag.text === 'string' ? tag.text : (tag.text ?? []).map((p: any) => p.text).join('');
      tagText = tagText.replace(/\{@link\s+([^}]*?)\s*\}/g, '{@link $1 }');
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
    // the same ProjectInfo. jsiiVersion carries an explicit marker so consumers
    // can tell an assembly was produced by the experimental backend.
    const jsiiVersion = `${info.jsiiVersionFormat === 'short' ? SHORT_VERSION : VERSION} (ts7 experimental)`;

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
      targets: info.targets as spec.Assembly['targets'],
      metadata: {
        ...info.metadata,
        // Downstream consumers need these to map a symbolId in the outDir to a
        // symbolId in the rootDir (same as the classic backend records).
        ...(this.options.packageJson.jsii?.tsc?.rootDir != null
          ? { tscRootDir: this.options.packageJson.jsii.tsc.rootDir }
          : {}),
        ...(this.options.packageJson.jsii?.tsc?.outDir != null
          ? { tscOutDir: this.options.packageJson.jsii.tsc.outDir }
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
