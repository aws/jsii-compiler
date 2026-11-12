/*
 * ===========================================================================
 * Experimental TypeScript 7 (tsgo) backend for jsii.
 *
 * WHAT THIS IS
 *   A TypeScript-7-native reimplementation of the jsii Assembler that reads the
 *   out-of-process TypeScript 7 API (`typescript/sync`) directly and produces
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
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as spec from '@jsii/spec';

import { findDependencyDirectory } from '../common/find-utils';
import { symbolIdentifier } from '../common/symbol-id';
import { normalizeConfigPath } from '../helpers';
import { JsiiDiagnostic } from '../jsii-diagnostic';
import * as literate from '../literate';
import { validateTargets, type ProjectInfo } from '../project-info';
import { isAllowedCovariantSubtype } from '../type-analysis';
import { createTypeResolver } from '../type-reference';
import { SHORT_VERSION, VERSION } from '../version';
import { Ts7Api } from './ts7-api';
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
 * Reproduces the subset of jsii's assembly generation needed for normal-path
 * `.jsii` parity, over the TS7 API.
 */
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
function loadSubmoduleReadMe(submoduleMain: string, projectRoot: string): spec.ReadMe | undefined {
  const fileBase = path.basename(submoduleMain).replace(/(\.d)?\.ts$/, '');
  const readMeName = fileBase === 'index' ? 'README.md' : `${fileBase}.README.md`;
  const readmePath = path.join(path.dirname(submoduleMain), readMeName);
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

/** Port of the classic services' `findLinkNameEnd` (where a `{@link}` name ends inside its text). */
function findLinkNameEnd(text: string): number {
  let pos = text.indexOf('://');
  if (pos === 0) {
    while (pos < text.length && text.charCodeAt(pos) !== 124) {
      pos++;
    }
    return pos;
  }
  if (text.indexOf('()') === 0) {
    return 2;
  }
  if (text.charAt(0) === '<') {
    let brackets = 0;
    let i = 0;
    while (i < text.length) {
      if (text[i] === '<') {
        brackets++;
      }
      if (text[i] === '>') {
        brackets--;
      }
      i++;
      if (!brackets) {
        return i;
      }
    }
  }
  return 0;
}

/** Port of the classic services' `skipSeparatorFromLinkText`. */
function skipSeparatorFromLinkText(text: string): string {
  let pos = 0;
  if (text.charCodeAt(pos++) === 124) {
    while (pos < text.length && text.charCodeAt(pos) === 32) {
      pos++;
    }
    return text.slice(pos);
  }
  return text;
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

export class Ts7Assembler {
  private readonly ts7: Ts7Api;
  private readonly checker: any;
  private readonly program: any;
  private readonly project: Ts7Project;

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

  public constructor(ts7: Ts7Api, project: Ts7Project, private readonly options: Ts7AssemblerOptions) {
    this.ts7 = ts7;
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
    const { SymbolFlags } = this.ts7;
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
    const rawComment = commentLines.join('\n');
    if (!/\{@link(code|plain)?\b/.test(rawComment)) {
      return comment;
    }
    const linkRe = /\{@(link|linkcode|linkplain)([^}\n]*)\}/g;
    let result = comment;
    let cursor = 0;
    let rawRendered = rawComment;
    let allFound = true;
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
      let classic: string;
      let modern: string;
      if (!nm) {
        classic = `{@${kind} ${after}}`;
        modern = after;
      } else {
        const name0 = nm[0];
        const text = after.slice(name0.length);
        const suffix = findLinkNameEnd(text);
        const name = name0 + text.slice(0, suffix);
        const rest = skipSeparatorFromLinkText(text.slice(suffix));
        const resolved = !name0.includes('#') && this._resolvesLinkName(name0, decl);
        if (resolved) {
          classic = `{@${kind} ${name}${rest}}`;
        } else {
          const separator = suffix === 0 || (text.charCodeAt(suffix) === 124 && !name.endsWith(' ')) ? ' ' : '';
          classic = `{@${kind} ${name}${separator}${rest}}`;
        }
        modern = `${name0.replace(/#/g, '.')}${text}`;
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
    const { SymbolFlags, SyntaxKind } = this.ts7;
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
    const { SyntaxKind, SymbolFlags } = this.ts7;
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
    const { SyntaxKind } = this.ts7;
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
    const decl = declH && declH.kind !== this.ts7.SyntaxKind.SourceFile ? declH.resolve(this.project) : undefined;
    const result: spec.Submodule = {
      ...(decl ? { locationInModule: this._locationOf(decl) } : {}),
      ...(isModuleFile ? { symbolId: this._symbolIdOf(moduleSym) } : { symbolId: this._symbolIdOf(exportSym) }),
    };
    if (!isModuleFile) {
      return result;
    }
    const submoduleMain: string | undefined = moduleSym.declarations?.[0]?.path;
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
    }
    return this.usedFeatures.size > 0 ? Array.from(this.usedFeatures).sort() : undefined;
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
    const { SyntaxKind } = this.ts7;
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
    const { SyntaxKind } = this.ts7;
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
    const { SyntaxKind } = this.ts7;
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
    const { SyntaxKind, SymbolFlags } = this.ts7;
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
    const { SyntaxKind } = this.ts7;
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
    const { SyntaxKind } = this.ts7;
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
    const { SyntaxKind } = this.ts7;
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
    if (comments === undefined && decl?.parent?.kind === this.ts7.SyntaxKind.Constructor) {
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
    const { SyntaxKind } = this.ts7;
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
    const { SyntaxKind } = this.ts7;
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
    const { TypeFlags } = this.ts7;
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
    const { TypeFlags } = this.ts7;
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
      let tagText = typeof tag.text === 'string' ? tag.text : (tag.text ?? []).map((p: any) => p.text).join('');
      tagText = tagText.replace(/\{@link\s+([^}]*?)\s*\}/g, '{@link $1 }');
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
