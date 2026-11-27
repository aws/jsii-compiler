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
 * Not produced here (yet): most of the JSII_xxxx validation diagnostics of the
 * previous validator; they are ported one group at a time through `_report`.
 * TypeScript compilation errors are surfaced and fail the build (see
 * compiler.ts).
 * ===========================================================================
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as spec from '@jsii/spec';
import deepEqual from 'fast-deep-equal';

import * as Case from './case';
import { findDependencyDirectory } from './common/find-utils';
import { symbolIdentifier } from './common/symbol-id';
import { TypeScriptApi, TypeScriptProject } from './compiler-host';
import { DiagnosticCategory } from './diagnostic';
import { Directives } from './directives';
import { normalizeConfigPath } from './helpers';
import { Code, DiagnosticLocation, DiagnosticMessageFormatter, JsiiDiagnostic } from './jsii-diagnostic';
import * as literate from './literate';
import { validateTargets, type ProjectInfo } from './project-info';
import { isReservedName } from './reserved-words';
import { isAllowedCovariantSubtype } from './type-analysis';
import { compareUnionMembers, createTypeResolver, typeReferenceEqual, typeReferenceToString } from './type-reference';
import { isBehavioralInterfaceType, isDataType, visitTypeReference } from './type-visitor';
import { parentFqn } from './utils';
import { SHORT_VERSION, VERSION } from './version';
import { parseWarningCodes, suppressInline } from './warnings';

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
  /** Enum member declarations by enum fqn and member name (read by --add-deprecation-warnings). */
  public readonly enumMemberDeclarations = new Map<string, Map<string, any>>();
  /** Classes left out by --strip-deprecated (their code is still emitted, with rtti, as by the classic compiler). */
  public readonly strippedClasses = new Array<spec.ClassType>();
  private readonly submodules: Record<string, spec.Submodule> = {};
  private readonly typeFqnBySymbolId = new Map<unknown, string>();
  private readonly exported: RegisteredType[] = [];

  // Perf caches: memoize per-symbol doc reads (each is an RPC), keyed by
  // the symbol's declaration coordinate (path:index), which is stable.
  private readonly _jsDocTagsCache = new Map<string, any[]>();
  private readonly _docCommentCache = new Map<string, any>();
  private readonly _sourceTextCache = new Map<string, string>();
  private readonly _typeOfSymbolAtCache = new Map<string, any>();
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

  /** The export symbol of each submodule, by submodule fqn (classic `_submodules` keys). */
  private readonly submoduleSymbols = new Map<string, any>();
  /** The declaration each type and member of the assembly was read from (classic `node-bindings`). */
  private readonly relatedNodes = new WeakMap<object, any>();
  /**
   * Checks that need the whole type model, run in registration order once all
   * types are visited (classic `_deferUntilTypesAvailable`).
   *
   * shortcut: runs in registration order, not in the classic dependency order;
   * diagnostics can come out in another order when deferred checks depend on
   * types that are visited later. Upgrade if the order of diagnostics matters.
   */
  private readonly deferred = new Array<() => void>();
  /** The JSII5018 diagnostics already reported, by `file:start:name`. */
  private readonly reservedWordReports = new Set<string>();

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
    if (this.assemblyName.includes('.')) {
      this._diagnostics.push(JsiiDiagnostic.JSII_0009_PACKAGE_NAME_CONTAINS_DOT.createDetached(this.assemblyName));
    }
    this._loadDependencyAssemblies();

    const entrySf = this.program.getSourceFile(this.entry);
    if (!entrySf) {
      throw new Error(`ts: entrypoint not found: ${this.entry}`);
    }
    const moduleSymbol = this.checker.getSymbolAtLocation(entrySf);
    const moduleExports = this._exportsOfModule(moduleSymbol);

    this._registerModuleExports(moduleExports, moduleSymbol.declarations?.[0]?.path);

    for (const { name, sym, decl, fqn } of this.exported) {
      this._visitNode(name, sym, decl, fqn);
    }

    this._propagateDatatype();

    for (const check of this.deferred) {
      check();
    }

    this._validateTypesAgainstPositions();

    const assembly = this._buildAssembly();
    // Classic: the validator runs on the finished assembly, and only when the
    // assembler itself reported no error.
    if (!this._diagnostics.some((d) => d.category === DiagnosticCategory.Error)) {
      this._validateNames(assembly);
    }
    return assembly;
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
   * of its declarations (the classic `_isPrivateOrInternal`). Like the classic
   * check, it reads the directives of a symbol before its `@internal` tag and
   * name, and not at all for a private member.
   */
  private _isInternal(sym: any): boolean {
    const ignored =
      this._jsDocTags(sym).some((t: any) => t.name === 'jsii') && !this._isPrivate(sym) && this._isIgnored(sym);
    return ignored || this._jsDocTags(sym).some((t: any) => t.name === 'internal') || sym.name.startsWith('_');
  }

  /** Whether a member symbol is `private`, or is named with `#`. */
  private _isPrivate(sym: any): boolean {
    if (sym.name.startsWith('#')) {
      return true;
    }
    const decl = sym.declarations?.[0]?.resolve(this.project);
    return (decl?.modifiers ?? []).some((m: any) => m.kind === this.ts.SyntaxKind.PrivateKeyword);
  }

  /**
   * Whether every declaration of the symbol carries the `@jsii ignore` directive.
   * All declarations must be ignored so that a partially-ignored merged
   * declaration stays a visible part of the public API, as in the classic
   * compiler. Parsing the directives of a declaration reports JSII2000 and
   * JSII2999. The tags of a symbol are aggregated over its declarations, so
   * declarations are only resolved when the symbol has a `@jsii` tag at all.
   */
  private _isIgnored(sym: any): boolean {
    const decls: any[] = sym.declarations ?? [];
    if (decls.length === 0 || !this._jsDocTags(sym).some((t: any) => t.name === 'jsii')) {
      return false;
    }
    return decls.every((handle) => this._directivesOf(handle.resolve(this.project)).ignore != null);
  }

  private _directivesOf(node: any): Directives {
    return Directives.of(node, (diag) => this._diagnostics.push(diag));
  }

  /**
   * Whether a `@jsii suppress` directive on the node, or on one of its
   * ancestors, suppresses the warning with this code.
   */
  private _isSuppressed(node: any, jsiiCode: number): boolean {
    for (let current = node; current != null; current = current.parent) {
      for (const code of this._directivesOf(current).suppressions) {
        try {
          if (parseWarningCodes(code).includes(jsiiCode)) {
            return true;
          }
        } catch {
          // Unknown code: ignore
        }
      }
    }
    return false;
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
  // @TODO(NEXT): this re-renders `{@link}` like TS6's language service, trailing space in `{@link Foo }` included;
  // TS7 renders links as plain text. After 7.1's first release: use TS7's rendering and drop the raw-JSDoc pass.
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
    const linkRe = /\{@(linkcode|linkplain|link)\b([^}\n]*)\}/g;
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
   * Read the JSDoc tags and documentation comment of the symbols that are not
   * cached yet in one batch, instead of two round trips per symbol. The values
   * are the ones `_jsDocTags` and `_docComment` would read.
   */
  private _prefetchDocs(syms: any[]): void {
    const todo: Array<{ tags: boolean; sym: any; key: string }> = [];
    const seen = new Set<string>();
    for (const sym of syms) {
      const key = this._symbolDocKey(sym);
      if (key == null || seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (!this._jsDocTagsCache.has(key)) {
        todo.push({ tags: true, sym, key });
      }
      if (!this._docCommentCache.has(key)) {
        todo.push({ tags: false, sym, key });
      }
    }
    if (todo.length < 2) {
      return;
    }
    let results: any[];
    try {
      results = this.project.api.batch(
        ...todo.map((t) =>
          t.tags ? t.sym.getJsDocTags.gen(this.checker) : t.sym.getDocumentationComment.gen(this.checker),
        ),
      );
    } catch {
      // shortcut: a failed batch reads nothing ahead; each symbol is then read on its own, as before.
      return;
    }
    for (const [i, t] of todo.entries()) {
      if (t.tags) {
        this._jsDocTagsCache.set(t.key, results[i] ?? []);
      } else {
        this._docCommentCache.set(t.key, results[i] ?? null);
      }
    }
  }

  /** `checker.getTypeOfSymbolAtLocation`, from the values `_prefetchPropertyTypes` read ahead when there is one. */
  private _typeOfSymbolAt(sym: any, node: any): any {
    const key = `${sym.id}|${node.id}`;
    return this._typeOfSymbolAtCache.has(key)
      ? this._typeOfSymbolAtCache.get(key)
      : this.checker.getTypeOfSymbolAtLocation(sym, node);
  }

  /**
   * Read the type of each property declared by the type (as `_visitProperty` reads it) in one batch, instead of a
   * round trip per property. Properties declared elsewhere are mostly not listed on this type, so they are left out.
   */
  private _prefetchPropertyTypes(props: readonly any[], typeDecl: any): void {
    const { SymbolFlags, SyntaxKind } = this.ts;
    const todo: Array<{ sym: any; node: any; key: string }> = [];
    for (const p of props) {
      if ((p.flags & SymbolFlags.Method) !== 0) {
        continue;
      }
      const node = p.declarations?.[0]?.resolve(this.project);
      const owner = node?.kind === SyntaxKind.Parameter ? node.parent?.parent : node?.parent;
      const key = `${p.id}|${node?.id}`;
      if (node != null && owner === typeDecl && !this._typeOfSymbolAtCache.has(key)) {
        todo.push({ sym: p, node, key });
      }
    }
    if (todo.length < 2) {
      return;
    }
    let results: any[];
    try {
      results = this.project.api.batch(...todo.map((t) => this.checker.getTypeOfSymbolAtLocation.gen(t.sym, t.node)));
    } catch {
      // shortcut: a failed batch reads nothing ahead; each property is then read on its own, as before.
      return;
    }
    for (const [i, t] of todo.entries()) {
      this._typeOfSymbolAtCache.set(t.key, results[i]);
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
    // The same set as the classic compiler: `dependencies` (minus bundled ones) and `peerDependencies`.
    const { dependencies, peerDependencies } = this.options.projectInfo;
    for (const dep of Object.keys({ ...dependencies, ...peerDependencies })) {
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

  /**
   * The exports of a module in the order of the classic `getExportsOfModule`: the module's own exports first, then
   * the names that its `export * from` declarations add, depth first. The TypeScript 7 checker lists the `export *`
   * names first; jsii visits types (and so orders `assembly.types` and the deprecation validators) in this order.
   */
  // @TODO(NEXT): this re-sorts TS7's export order to TS6's only so `assembly.types` (and the fingerprint) match main.
  // After 7.1's first release: use `checker.getExportsOfModule` order as is.
  private _exportsOfModule(moduleSym: any): any[] {
    // @TODO(NEXT): this walk only reproduces the TypeScript 6 order so that `assembly.types` and the validators in
    // `.warnings.jsii.js` come out as on main; the order has no meaning of its own. After 7.1's first release, use
    // `checker.getExportsOfModule` as is and drop this method (outputs that follow the type order change once).
    const exports: any[] = this.checker.getExportsOfModule(moduleSym);
    const rank = new Map<string, number>();
    const visited = new Set<unknown>();
    const visit = (sym: any): void => {
      if (sym == null || visited.has(sym.id)) {
        return;
      }
      visited.add(sym.id);
      const stars: any[] = [];
      for (const [name, own] of sym.getExports?.() ?? []) {
        if (name === '__export') {
          stars.push(own);
        } else if (!rank.has(name)) {
          rank.set(name, rank.size);
        }
      }
      for (const star of stars) {
        for (const handle of star.declarations ?? []) {
          const specifier = handle.resolve(this.project)?.moduleSpecifier;
          visit(specifier && this.checker.getSymbolAtLocation(specifier));
        }
      }
    };
    visit(moduleSym);
    // Names not found by the walk keep their relative order, after the others.
    const rankOf = (e: any) => rank.get(e.name) ?? rank.size;
    return exports
      .map((e, index) => ({ e, index }))
      .sort((a, b) => rankOf(a.e) - rankOf(b.e) || a.index - b.index)
      .map(({ e }) => e);
  }

  /**
   * Classic `_addToSubmodule`: a symbol may be exported by only one submodule (by name); JSII3003 otherwise.
   */
  private _registerSubmoduleSymbol(submoduleOfSymbol: Map<unknown, any>, symbol: any, ns: any): void {
    const current = submoduleOfSymbol.get(symbol.id);
    if (current == null) {
      submoduleOfSymbol.set(symbol.id, ns);
      return;
    }
    if (current.name === ns.name) {
      return;
    }
    const declOf = (s: any) => (s.valueDeclaration ?? s.declarations?.[0])?.resolve(this.project);
    // The causes are listed in the same order every time.
    const refs = [
      { decl: declOf(current), name: current.name as string },
      { decl: declOf(ns), name: ns.name as string },
    ].sort(({ name: l }, { name: r }) => l.localeCompare(r));
    this._report(
      JsiiDiagnostic.JSII_3003_SYMBOL_IS_EXPORTED_TWICE,
      this._nameOrDeclaration(declOf(symbol)),
      refs[0].name,
      refs[1].name,
    )
      .addRelatedInformationIf(
        this._diagnosticLocation(refs[0].decl),
        `Symbol is exported under the "${refs[0].name}" submodule`,
      )
      .addRelatedInformationIf(
        this._diagnosticLocation(refs[1].decl),
        `Symbol is exported under the "${refs[1].name}" submodule`,
      );
  }

  private _registerModuleExports(moduleExports: any[], entryPath?: string): void {
    const { SyntaxKind, SymbolFlags } = this.ts;
    const candidates = new Map<
      unknown,
      Array<{
        name: string;
        prefix: string;
        moduleDir: string;
        moduleFile?: string;
        sym: any;
        aliasDeclH?: any;
        seq: number;
      }>
    >();
    const visitedModules = new Set<string>();
    // The order in which exports are seen: the classic assembler visited (and registered) types in this order.
    let seq = 0;

    // The submodule (its export symbol) each symbol exported by a submodule belongs to, for JSII3003.
    const submoduleOfSymbol = new Map<unknown, any>();
    const collect = (mExports: any[], prefix: string, moduleDir: string, moduleFile?: string, ns?: any): void => {
      for (const e of mExports) {
        if (ns != null) {
          this._registerSubmoduleSymbol(submoduleOfSymbol, e, ns);
        }
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
          candidates.get(sym.id)!.push({ name: e.name, prefix, moduleDir, moduleFile, sym, aliasDeclH, seq: seq++ });
        } else if (
          kind === SyntaxKind.SourceFile ||
          (sym.flags & SymbolFlags.ValueModule) !== 0 ||
          (sym.flags & SymbolFlags.NamespaceModule) !== 0
        ) {
          if (kind !== SyntaxKind.SourceFile && this._isIgnored(sym)) {
            continue; // `@jsii ignore` on a namespace hides all of its nested declarations
          }
          const exportDeclH = e.declarations?.[0];
          if (
            kind === SyntaxKind.SourceFile &&
            (e.flags & SymbolFlags.Alias) !== 0 &&
            exportDeclH?.kind === SyntaxKind.ExportSpecifier
          ) {
            // Classic: `import * as A from '...'; export { A };` resolves to the import, which no _visitNode branch
            // handles, so it is not a submodule.
            continue;
          }
          if (
            kind === SyntaxKind.SourceFile &&
            exportDeclH?.kind === SyntaxKind.NamespaceExport &&
            this._dependencyOfPath(declH.path ?? '') == null &&
            e.name !== Case.camel(e.name) &&
            e.name !== Case.snake(e.name)
          ) {
            this._report(
              JsiiDiagnostic.JSII_8004_SUBMOULE_NAME_CASING,
              exportDeclH.resolve(this.project)?.name,
              e.name,
            );
          }
          const subFqn = `${prefix}.${e.name}`;
          const key = `${sym.id}:${subFqn}`;
          if (visitedModules.has(key)) {
            continue;
          }
          visitedModules.add(key);
          this.submoduleSymbols.set(subFqn, e);
          this.submodules[subFqn] = this._submoduleSpec(e, sym, kind === SyntaxKind.SourceFile);
          const subDir = path.dirname(sym.declarations?.[0]?.path ?? moduleDir);
          const subFile = kind === SyntaxKind.SourceFile ? sym.declarations?.[0]?.path : undefined;
          collect(this._exportsOfModule(sym), subFqn, subDir, subFile, e);
        } else {
          this._reportUnsupportedExport(sym, declH);
        }
      }
    };
    collect(moduleExports, this.assemblyName, path.dirname(this.entry), entryPath);
    this._validateSubmoduleConfigs();

    // FQN attribution: the *canonical* home of a type is the shortest module
    // path that contains its declaration (the shortest-module-path "best
    // candidate" selection); typeFqnBySymbolId (reference resolution) uses it.
    // A symbol additionally exported from OTHER submodules (cross-submodule
    // re-export, e.g. aws_docdb re-exporting aws_rds.CaCertificate) gets a full
    // duplicate type entry under each such fqn — strada emits one entry per
    // namespace visit.
    const registrations: Array<{ sym: any; name: string; fqn: string; seq: number }> = [];
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
      // Classic: a file that is itself a (sub)module (`export * as ns from './file'`) gives its types that
      // module's fqn, even when another module in the same directory exports them as well.
      best = cands.find((c) => c.moduleFile != null && c.moduleFile === c.sym.declarations?.[0]?.path) ?? best;
      // Classic: a type is named after its declaration, also when it is exported under another name
      // (`export { X as Y }` gives `X`).
      // @TODO(NEXT): the package does not export `X` then, so bindings cannot load it
      // (https://github.com/aws/jsii-compiler/issues/3033). After 7.1's first release, name the entry after the
      // export (`best.name`, `c.name`) or report renamed re-exports as an error.
      const name = best.sym.name;
      const bestFqn = `${best.prefix}.${name}`;
      registrations.push({ sym: best.sym, name, fqn: bestFqn, seq: best.seq });
      const extraFqns = new Set<string>([bestFqn]);
      for (const c of cands) {
        const fqn = `${c.prefix}.${name}`;
        if (extraFqns.has(fqn)) {
          continue;
        }
        // strada visits every export of every module, so each module that exports the type (directly, through
        // `export *` or through `export { X } from '...'`) gets an entry of its own. Aliases that go through a
        // local import (`import { X } ...; export { X };`) are dropped by strada's visitor: their ExportSpecifier
        // resolves to an ImportSpecifier, which no _visitNode branch handles.
        // @TODO(NEXT): copies of one class under several fqns share one runtime class, which carries only one of
        // the fqns, and re-exporting through a local import drops the entry for no reason. After 7.1's first
        // release, keep one entry per type at its canonical fqn and treat every re-export (with or without a
        // module specifier) the same way.
        if (c.aliasDeclH != null) {
          if (c.aliasDeclH.kind !== SyntaxKind.ExportSpecifier) {
            continue;
          }
          const aliasDecl = c.aliasDeclH.resolve(this.project);
          const exportDeclNode = aliasDecl?.parent?.parent;
          if (exportDeclNode?.moduleSpecifier == null) {
            continue;
          }
        }
        extraFqns.add(fqn);
        registrations.push({ sym: c.sym, name, fqn, seq: c.seq });
      }
    }
    // Batch-prefetch docs for all candidate type symbols (used by the
    // isInternal/shouldStrip checks inside _registerType).
    this._prefetchDocs(registrations.map((r) => r.sym));
    // Register canonical fqns first (references resolve to the first registration of a symbol), then visit the
    // types in the order their exports were seen; nested types stay right after their parent.
    const seqOf = new Map<unknown, number>();
    for (const r of registrations) {
      const start = this.exported.length;
      this._registerType(r.sym, r.name, r.fqn);
      for (const entry of this.exported.slice(start)) {
        seqOf.set(entry, r.seq);
      }
    }
    const visitOrder = this.exported
      .map((entry, index) => ({ entry, index }))
      .sort((x, y) => (seqOf.get(x.entry) ?? 0) - (seqOf.get(y.entry) ?? 0) || x.index - y.index)
      .map(({ entry }) => entry);
    this.exported.splice(0, this.exported.length, ...visitOrder);
  }

  private _registerType(sym: any, name: string, fqn: string): void {
    const { SyntaxKind } = this.ts;
    const isFirst = !this.typeFqnBySymbolId.has(sym.id);
    if (!isFirst) {
      // Already registered under its canonical fqn. A *different* fqn means a
      // cross-submodule re-export: emit a duplicate entry under that fqn too
      // (its nested types get entries under that fqn as well).
      if (this.typeFqnBySymbolId.get(sym.id) === fqn || this.exported.some((e) => e.fqn === fqn)) {
        return;
      }
    }
    if (this._isInternal(sym)) {
      return;
    }
    if (this._shouldStrip(sym, fqn)) {
      this.strippedTypeSymIds.add(sym.id);
      const strippedDecl = sym.declarations?.[0]?.resolve(this.project);
      if (strippedDecl?.kind === SyntaxKind.ClassDeclaration) {
        this.strippedClasses.push({
          assembly: this.assemblyName,
          fqn,
          kind: spec.TypeKind.Class,
          name,
          symbolId: this._symbolIdOf(sym),
          locationInModule: this._locationOf(strippedDecl),
        });
      }
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

    // nested exported types (namespaces on a class/interface), under every fqn of the type, like strada
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
  /**
   * Classic `_visitNode`: an exported declaration that is not a class, interface, enum or namespace (a function, a
   * variable, a type alias, ...) is not part of the jsii type model (JSII9998).
   */
  private _reportUnsupportedExport(sym: any, declH: any): void {
    const { SyntaxKind } = this.ts;
    const decl = declH.resolve(this.project);
    const modifiersOwner = decl?.kind === SyntaxKind.VariableDeclaration ? decl.parent?.parent : decl;
    if (!(modifiersOwner?.modifiers ?? []).some((m: any) => m.kind === SyntaxKind.ExportKeyword)) {
      return;
    }
    if (this._isIgnored(sym)) {
      return;
    }
    this._report(JsiiDiagnostic.JSII_9998_UNSUPPORTED_NODE, this._nameOrDeclaration(decl), SyntaxKind[decl.kind]);
  }

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
    this._warnAboutReservedWords(name, decl);
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
    this.relatedNodes.set(jsiiType, decl);
    this._validateSubmoduleNameConflicts(name, fqn, decl);
    this._validateNoNamespaceInType(sym, decl, fqn);
    this.types[fqn] = jsiiType as spec.Type;
  }

  /**
   * A type must not have the name of a submodule declared next to it, in any of
   * the casings target languages may give the submodule (classic `_visitNode`).
   * Submodules may be renamed by `.jsiirc.json`; that is not considered.
   */
  private _validateSubmoduleNameConflicts(name: string, fqn: string, decl: any): void {
    const typeFqnPrefix = parentFqn(fqn);
    for (const [submoduleFqn, submodule] of this.submoduleSymbols) {
      if (typeFqnPrefix !== parentFqn(submoduleFqn)) {
        continue;
      }
      const candidates = Array.from(
        new Set([submodule.name, Case.camel(submodule.name), Case.pascal(submodule.name), Case.snake(submodule.name)]),
      );
      if (candidates.some((candidate) => candidate === name)) {
        const submoduleDecl = (submodule.valueDeclaration ?? submodule.declarations?.[0])?.resolve(this.project);
        this._report(
          JsiiDiagnostic.JSII_5011_SUBMODULE_NAME_CONFLICT,
          this._nameOrDeclaration(decl),
          submodule.name,
          name,
          candidates,
        ).addRelatedInformationIf(
          this._diagnosticLocation(this._nameOrDeclaration(submoduleDecl)),
          'This is the conflicting submodule declaration',
        );
      }
    }
  }

  /**
   * Everything nested under a type must be a type: a namespace merged into a
   * type must not declare more namespaces with types in them (classic
   * `_visitNode`). One error per such namespace that declares types.
   */
  private _validateNoNamespaceInType(sym: any, decl: any, fqn: string): void {
    const { SyntaxKind } = this.ts;
    if (decl.kind === SyntaxKind.EnumDeclaration) {
      return;
    }
    const typeKinds = [SyntaxKind.ClassDeclaration, SyntaxKind.InterfaceDeclaration, SyntaxKind.EnumDeclaration];
    const typeNamespace = fqn.slice(this.assemblyName.length + 1);
    // Classic: one error per type, but the compiler drops duplicates (same node and message), so one per namespace.
    const reported = new Set<string>();
    const visit = (nsym: any, namespace: string): void => {
      for (const [, member0] of nsym.getExports?.() ?? []) {
        const member = this._resolveAlias(member0);
        const kind = member.declarations?.[0]?.kind;
        if (kind === SyntaxKind.ModuleDeclaration) {
          visit(member, `${namespace}.${member.name}`);
        } else if (
          typeKinds.includes(kind) &&
          namespace !== typeNamespace &&
          !this._jsDocTags(member).some((t: any) => t.name === 'internal') &&
          !this._isIgnored(member) &&
          !reported.has(namespace)
        ) {
          reported.add(namespace);
          this._report(JsiiDiagnostic.JSII_5012_NAMESPACE_IN_TYPE, this._nameOrDeclaration(decl), fqn, namespace);
        }
      }
    };
    visit(sym, typeNamespace);
  }

  private _visitEnum(sym: any, decl: any, fqn: string, jsiiType: any): void {
    const { SyntaxKind } = this.ts;
    jsiiType.kind = 'enum';

    this._assertNoDuplicateEnumValues(decl);
    const constModifier = (decl.modifiers ?? []).find((mod: any) => mod.kind === SyntaxKind.ConstKeyword);
    if (constModifier) {
      this._report(JsiiDiagnostic.JSII_1000_NO_CONST_ENUM, constModifier);
    }
    for (const memberDecl of decl.members ?? []) {
      if (this.checker.getConstantValue(memberDecl) === undefined) {
        this._report(JsiiDiagnostic.JSII_1012_ONLY_CONST_ENUM_MEMBERS, memberDecl);
      }
    }

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
    const memberDecls = new Map<string, any>();
    this.enumMemberDeclarations.set(fqn, memberDecls);
    for (const msym of enumMembers) {
      if (msym.declarations?.[0]?.kind !== SyntaxKind.EnumMember) {
        continue;
      }
      // The classic assembler does not hide enum members that are `@internal`, `_`-prefixed or `@jsii ignore`d.
      if (this._shouldStrip(msym, `${fqn}#${msym.name}`)) {
        continue;
      }
      const member: any = { name: msym.name };
      const md = this._visitDocumentation(msym);
      if (md) {
        member.docs = md;
      }
      members.push(this._withDefaultDocs(member));
      memberDecls.set(msym.name, msym.declarations[0]);
    }
    jsiiType.members = members;

    if (Case.pascal(sym.name) !== sym.name) {
      this._report(JsiiDiagnostic.JSII_8000_PASCAL_CASED_TYPE_NAMES, decl.name, sym.name);
    }
  }

  /** Classic: JSII_1004 for each initializer text that more than one member of the enum uses. */
  private _assertNoDuplicateEnumValues(decl: any): void {
    const sf = decl.getSourceFile();
    const text = this._sourceTextOf(sf);
    const textOf = (node: any) => text.slice(node.getStart(sf), node.end);
    // A plain object, like the classic assembler: integer-like values come first, in numeric order.
    const membersByValue: Record<string, any[]> = {};
    for (const member of decl.members ?? []) {
      if (member.initializer == null) {
        continue;
      }
      const value = textOf(member.initializer);
      (membersByValue[value] ??= []).push(member);
    }
    for (const [value, members] of Object.entries(membersByValue)) {
      if (members.length < 2) {
        continue;
      }
      const err = this._report(
        JsiiDiagnostic.JSII_1004_DUPLICATE_ENUM_VALUE,
        members[0].name,
        value,
        members.map((m) => textOf(m.name)),
      );
      for (const member of members.slice(1)) {
        err.addRelatedInformationIf(this._diagnosticLocation(member.name), 'The conflicting declaration is here');
      }
    }
  }

  /** Classic: JSII_1006 for each type parameter of a class or interface declaration. */
  private _reportTypeParameters(decl: any): void {
    for (const typeParam of decl.typeParameters ?? []) {
      this._report(JsiiDiagnostic.JSII_1006_GENERIC_TYPE, typeParam);
    }
  }

  /**
   * Whether the index signature of a type is hidden from jsii (`@internal` or `@jsii ignore`). Like the classic
   * assembler, this looks up the `__index` symbol of the type being visited (instance first, then static).
   */
  private _isHiddenIndexSignature(typeSym: any): boolean {
    const indexSym = typeSym.getMembers?.()?.get('__index') ?? typeSym.getExports?.()?.get('__index');
    return (
      indexSym != null &&
      (this._jsDocTags(indexSym).some((t: any) => t.name === 'internal') || this._isIgnored(indexSym))
    );
  }

  private _visitInterface(sym: any, decl: any, name: string, jsiiType: any): void {
    jsiiType.kind = 'interface';
    const type = this.checker.getTypeAtLocation(decl);
    const baseTypes = type.getBaseTypes();
    const { interfaces, erasedBases } = this._processBaseInterfaces(baseTypes);
    if (interfaces.length) {
      const rewrittenByStrip = erasedBases.some((b) => this.strippedTypeSymIds.has((b.getSymbol?.() ?? b.symbol)?.id));
      jsiiType.interfaces = rewrittenByStrip ? [...interfaces].sort() : interfaces;
    }

    const heritageNodes = (decl.heritageClauses ?? []).flatMap((h: any) => h.types);
    if (
      heritageNodes.length !== (baseTypes ?? []).length ||
      (baseTypes ?? []).some((t: any) => !this._isValidSupertypeSymbol(t.getSymbol?.()))
    ) {
      // Only when a base can be invalid: the check asks TypeScript for the type of each heritage clause.
      this._validateHeritageClauses(decl, () => undefined);
    }
    this._verifySupertypes(jsiiType);

    this._reportTypeParameters(decl);
    for (const memberDecl of decl.members ?? []) {
      if (memberDecl.kind === this.ts.SyntaxKind.IndexSignature && !this._isHiddenIndexSignature(sym)) {
        this._report(JsiiDiagnostic.JSII_1999_UNSUPPORTED, memberDecl, {
          what: 'Index signatures',
          suggestInternal: true,
        });
      }
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
    // The classic path then validates all-readonly (JSII3008) and struct bases (JSII3007), see _validateInterfaceName.
    if ((jsiiType.methods ?? []).length === 0) {
      const hintsStruct = this._jsDocTags(sym).some((t: any) => t.name === 'struct');
      if (!isInterfaceName(name) || hintsStruct) {
        jsiiType.datatype = true;
      }
    }

    // Classic: checked once the datatype-ness of the bases is known, right away
    // when there are none.
    const validateName = () => this._validateInterfaceName(sym, decl, jsiiType);
    if ((jsiiType.interfaces ?? []).length === 0) {
      validateName();
    } else {
      this.deferred.push(validateName);
    }
    this._verifyRedeclaredInterfaceMembers(decl, jsiiType);
  }

  /**
   * Classic: an interface that re-declares a member of a base interface must keep its exact shape (JSII5015), as C#
   * interfaces cannot narrow inherited members. Checked against every base interface, nearest first, once all types
   * are known.
   */
  private _verifyRedeclaredInterfaceMembers(decl: any, jsiiType: spec.InterfaceType): void {
    if ((jsiiType.interfaces ?? []).length === 0) {
      return;
    }
    this.deferred.push(() => {
      const members = typeMembers(jsiiType);
      const check = (baseFqns: readonly string[]) => {
        for (const base of baseFqns.map((fqn) => this._dereferenceType(fqn))) {
          if (base == null || !spec.isInterfaceType(base)) {
            continue;
          }
          const baseMembers = typeMembers(base);
          for (const [memberName, member] of Object.entries(members)) {
            const baseMember = baseMembers[memberName];
            if (memberName === '' || baseMember == null || isIdenticalRedeclaration(member, baseMember)) {
              continue;
            }
            this._report(JsiiDiagnostic.JSII_5015_REDECLARED_INTERFACE_MEMBER, decl, memberName, jsiiType);
          }
          check(base.interfaces ?? []);
        }
      };
      check(jsiiType.interfaces ?? []);
    });
  }

  /**
   * Classic `_visitInterface`, once the datatype-ness of the bases is known: behavioral interfaces need an `I` prefix,
   * all interface names are PascalCased, struct properties are readonly (JSII3008) and behavioral interfaces do not
   * extend structs (JSII3007).
   */
  private _validateInterfaceName(sym: any, decl: any, jsiiType: any): void {
    const interfaceName = isInterfaceName(jsiiType.name);
    if (!jsiiType.datatype && !interfaceName) {
      this._report(JsiiDiagnostic.JSII_8007_BEHAVIORAL_INTERFACE_NAME, this._nameOrDeclaration(decl), jsiiType.name);
    }
    // NOTE: We need to be careful with the `I` prefix for behavioral interfaces, as this can mess with PascalCase
    // transformations, especially with short names such as `IA`, ...
    const expectedName = interfaceName ? `I${Case.pascal(sym.name.slice(1))}` : Case.pascal(sym.name);
    if (expectedName !== sym.name) {
      this._report(JsiiDiagnostic.JSII_8000_PASCAL_CASED_TYPE_NAMES, decl.name, sym.name, expectedName);
    }

    if (jsiiType.datatype) {
      // A struct's properties must be readonly; they are made readonly, since jsii languages pass structs by value.
      for (const prop of jsiiType.properties ?? []) {
        if (!prop.immutable) {
          this._report(
            JsiiDiagnostic.JSII_3008_STRUCT_PROPS_MUST_BE_READONLY,
            this._nameOrDeclaration(this.relatedNodes.get(prop)),
            prop.name,
            jsiiType,
          );
          prop.immutable = true;
        }
      }
    } else {
      // A behavioral interface may not extend a struct.
      for (const baseFqn of jsiiType.interfaces ?? []) {
        const base = this._dereferenceType(baseFqn);
        if (base != null && spec.isInterfaceType(base) && base.datatype) {
          this._report(JsiiDiagnostic.JSII_3007_ILLEGAL_STRUCT_EXTENSION, decl, jsiiType, base);
        }
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
        // Classic: a base that is neither hidden (internal, unexported, an anonymous type) nor a named type is not
        // erased: it is reported (JSII3005, e.g. `extends Array<string>`) and left out.
        if (s != null && !s.name.startsWith('__') && !this._isInternal(s) && !this._isOwnSourceDecl(s)) {
          const ref = this._typeReference(iface);
          if (!spec.isNamedTypeReference(ref)) {
            this._report(
              JsiiDiagnostic.JSII_3005_TYPE_USED_AS_INTERFACE,
              s.valueDeclaration?.resolve?.(this.project) ?? s.declarations?.[0]?.resolve(this.project),
              ref,
            );
            continue;
          }
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

  /** The type reference of a class's base class type (classic: from `getBaseTypes`, not the heritage expression). */
  private _baseClassReference(classDecl: any): any {
    const baseType = this.checker.getTypeAtLocation(classDecl)?.getBaseTypes?.()?.[0];
    return baseType ? this._typeReference(baseType) : undefined;
  }

  /** Whether a symbol is declared in the project's own sources (not in the standard library or a dependency). */
  private _isOwnSourceDecl(sym: any): boolean {
    const declPath: string = sym.declarations?.[0]?.path ?? '';
    return !this._isStdlibDecl(sym) && this._dependencyOfPath(declPath) == null && !declPath.includes('/node_modules/');
  }

  /** Whether all declarations of a supertype's symbol are classes, interfaces or modules (classic). */
  private _isValidSupertypeSymbol(sym: any): boolean {
    const { SyntaxKind } = this.ts;
    const valid = [SyntaxKind.ClassDeclaration, SyntaxKind.InterfaceDeclaration, SyntaxKind.ModuleDeclaration];
    return sym != null && (sym.declarations ?? []).every((d: any) => valid.includes(d.kind));
  }

  /**
   * Classic `_validateHeritageClauses`: the types a class or interface extends or implements must be classes or
   * interfaces (JSII3004). `symbolHint` gives a symbol already known for a heritage type; TypeScript is asked for the
   * type only when that symbol is missing or invalid.
   */
  private _validateHeritageClauses(decl: any, symbolHint: (node: any) => any): void {
    const { SyntaxKind } = this.ts;
    for (const clause of decl.heritageClauses ?? []) {
      for (const node of clause.types) {
        if (this._isValidSupertypeSymbol(symbolHint(node))) {
          continue;
        }
        const parentSym = this.checker.getTypeAtLocation(node)?.getSymbol?.();
        if (parentSym == null || this._isValidSupertypeSymbol(parentSym)) {
          // No symbol: an error type, TypeScript already reported the code.
          continue;
        }
        const valid = [SyntaxKind.ClassDeclaration, SyntaxKind.InterfaceDeclaration, SyntaxKind.ModuleDeclaration];
        const badHandle = (parentSym.declarations ?? []).find((d: any) => !valid.includes(d.kind));
        const clauseType = clause.token === SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
        this._report(
          JsiiDiagnostic.JSII_3004_INVALID_SUPERTYPE,
          node,
          clauseType,
          SyntaxKind[badHandle.kind],
        ).addRelatedInformationIf(
          this._diagnosticLocation(badHandle.resolve(this.project)),
          'The invalid super type is declared here.',
        );
      }
    }
  }

  /**
   * Classic, once all types are known: the base class of a class is a class (JSII3006), the interfaces of a class or
   * interface are interfaces (JSII3005), and a class does not implement a struct (JSII3007).
   */
  private _verifySupertypes(jsiiType: spec.ClassType | spec.InterfaceType): void {
    const declOf = (t: spec.Type) => this.relatedNodes.get(this.types[t.fqn]);
    this.deferred.push(() => {
      if (spec.isClassType(jsiiType) && jsiiType.base != null) {
        const base = this._dereferenceType(jsiiType.base);
        if (base != null && !spec.isClassType(base)) {
          this._report(JsiiDiagnostic.JSII_3006_TYPE_USED_AS_CLASS, declOf(base), { fqn: base.fqn });
        }
      }
      for (const fqn of jsiiType.interfaces ?? []) {
        const iface = this._dereferenceType(fqn);
        if (iface == null) {
          continue;
        }
        if (!spec.isInterfaceType(iface)) {
          this._report(JsiiDiagnostic.JSII_3005_TYPE_USED_AS_INTERFACE, declOf(iface), { fqn });
        } else if (spec.isClassType(jsiiType) && iface.datatype) {
          this._report(
            JsiiDiagnostic.JSII_3007_ILLEGAL_STRUCT_EXTENSION,
            this.relatedNodes.get(jsiiType),
            jsiiType,
            iface,
          );
        }
      }
    });
  }

  private _visitClass(sym: any, decl: any, jsiiType: any): void {
    const { SyntaxKind } = this.ts;
    jsiiType.kind = 'class';
    if (Case.pascal(sym.name) !== sym.name) {
      this._report(JsiiDiagnostic.JSII_8000_PASCAL_CASED_TYPE_NAMES, this._nameOrDeclaration(decl), sym.name);
    }
    this._reportTypeParameters(decl);
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
    // The symbols of the class's own heritage clauses, for _validateHeritageClauses.
    const ownHeritageSymbols = new Map<any, any>();
    let unnamedBaseRef: any;
    const collectHeritage = (classDecl: any): void => {
      const deferredBases: any[] = [];
      for (const h of classDecl.heritageClauses ?? []) {
        const isExt = h.token === SyntaxKind.ExtendsKeyword && classDecl.kind !== SyntaxKind.InterfaceDeclaration;
        for (const t of h.types) {
          const s = this._heritageBaseSymbol(t);
          if (classDecl === decl) {
            ownHeritageSymbols.set(t, s);
          }
          if (!s) {
            if (classDecl === decl && isExt && !this.checker.getTypeAtLocation(t)?.isErrorType?.()) {
              // Classic: a base class without a symbol (`extends make()`) cannot be named.
              this._report(JsiiDiagnostic.JSII_3004_INVALID_SUPERTYPE, t, 'extends', 'unnamed base type');
            }
            continue;
          }
          const fqnRef = this.typeFqnBySymbolId.get(s.id) ?? this._externalFqnOf(s);
          if (isExt) {
            if (fqnRef) {
              base.value ??= fqnRef;
            } else if (
              classDecl === decl &&
              !s.name.startsWith('__') &&
              !this._isInternal(s) &&
              !this._isOwnSourceDecl(s) &&
              (unnamedBaseRef ??= this._baseClassReference(decl)) != null &&
              !spec.isNamedTypeReference(unnamedBaseRef)
            ) {
              // Classic: a base class that is neither hidden nor a named type (`extends Array<string>`) is reported
              // and left out, not erased.
              this._report(
                JsiiDiagnostic.JSII_3006_TYPE_USED_AS_CLASS,
                (s.valueDeclaration ?? s.declarations?.[0])?.resolve(this.project),
                unnamedBaseRef,
              );
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
    this._validateHeritageClauses(decl, (t) => ownHeritageSymbols.get(t));
    this._verifySupertypes(jsiiType);
    // Classic: the member declarations of the class and of its erased base classes are checked in that order.
    for (const memberOwner of [decl, ...erasedDecls]) {
      for (const memberDecl of memberOwner.members ?? []) {
        if (memberDecl.kind === SyntaxKind.SemicolonClassElement) {
          this._report(JsiiDiagnostic.JSII_9996_UNNECESSARY_TOKEN, memberDecl);
        } else if (memberDecl.kind === SyntaxKind.ClassStaticBlockDeclaration) {
          this._report(JsiiDiagnostic.JSII_9998_UNSUPPORTED_NODE, memberDecl, SyntaxKind[memberDecl.kind]);
        } else if (memberDecl.kind === SyntaxKind.IndexSignature && !this._isHiddenIndexSignature(sym)) {
          this._report(JsiiDiagnostic.JSII_1999_UNSUPPORTED, memberDecl, {
            what: 'Index signatures',
            suggestInternal: true,
          });
        }
      }
    }
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
        const params = sig.getParameters().map((p: any) => {
          const param = this._visitParameter(p);
          if (containsIntersection(param.type)) {
            this._report(JsiiDiagnostic.JSII_1010_INTERSECTION_NOT_IN_CTOR, p.declarations?.[0]?.resolve(this.project));
          }
          return param;
        });
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
        this._verifyConsecutiveOptionals(effectiveCtor, initializer.parameters);
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
    this._verifyNoStaticMixing(jsiiType, decl);
  }

  /** Classic: JSII3009 for an optional parameter followed by a required one (the parameter becomes required). */
  private _verifyConsecutiveOptionals(node: any, parameters?: spec.Parameter[]): void {
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
        this._report(JsiiDiagnostic.JSII_3009_OPTIONAL_PARAMETER_BEFORE_REQUIRED, node, current, offender);
        delete (current as any).optional;
      }
    }
  }

  /**
   * Classic `_verifyNoStaticMixing`: a class may not declare a member both static and not (JSII5013), nor with a
   * staticness that differs from a member of the same name in a base class (JSII5014, once all types are known).
   */
  private _verifyNoStaticMixing(klass: spec.ClassType, decl: any): void {
    const members = [...(klass.methods ?? []), ...(klass.properties ?? [])];
    const nonStatics = new Set(members.filter((x) => !x.static).map((x) => x.name));
    for (const name of new Set(members.filter((x) => x.static).map((x) => x.name))) {
      if (nonStatics.has(name)) {
        this._report(JsiiDiagnostic.JSII_5013_STATIC_INSTANCE_CONFLICT, decl, name, klass);
      }
    }
    if (klass.base == null) {
      return;
    }
    this.deferred.push(() => {
      const classMembers = typeMembers(klass);
      for (let base = this._dereferenceType(klass.base!); base != null && spec.isClassType(base); ) {
        for (const [name, baseMember] of Object.entries(typeMembers(base))) {
          const member = classMembers[name];
          if (member != null && !!baseMember.static !== !!member.static) {
            this._report(JsiiDiagnostic.JSII_5014_INHERITED_STATIC_CONFLICT, decl, member, klass, baseMember, base);
          }
        }
        base = base.base != null ? this._dereferenceType(base.base) : undefined;
      }
    });
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
    this._prefetchPropertyTypes([...instanceProps, ...staticPropsForPrefetch], decl);
    this._validateInternalMembers(sym, decl, erasedBases, isInterface, instanceProps, staticPropsForPrefetch);

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
      // Classic: the declaring type of a class member is the declaration holding it
      // (the class owning the constructor for a parameter property); for an interface, the interface.
      const declaringTypeDecl = isInterface ? decl : owner;
      if ((p.flags & SymbolFlags.Method) !== 0) {
        const m = this._visitMethod(p, pDecl, false, jsiiType, declaringTypeDecl);
        if (m == null) {
          continue;
        }
        if (isInterface) {
          m.abstract = true;
        }
        methods.push(m);
      } else {
        const pr = this._visitProperty(p, pDecl, false, jsiiType, declaringTypeDecl);
        if (pr == null) {
          continue;
        }
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
        const member =
          (sp.flags & SymbolFlags.Method) !== 0
            ? this._visitMethod(sp, spDecl, true, jsiiType, spDecl.parent)
            : this._visitProperty(sp, spDecl, true, jsiiType, spDecl.parent);
        if (member == null) {
          continue;
        }
        ((sp.flags & SymbolFlags.Method) !== 0 ? methods : props).push(member);
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
   * A member left out of the type model for being `@internal` or `_`-prefixed
   * must be both (classic `_isPrivateOrInternal` with a declaration). Like the
   * classic assembler, this looks at the members declared by the type and by
   * its erased bases, overridden ones included: for a class at each member
   * declaration (a getter and its setter both count), for an interface at each
   * member of the type and of each erased base interface.
   */
  private _validateInternalMembers(
    sym: any,
    decl: any,
    erasedBases: any[],
    isInterface: boolean,
    instanceProps: readonly any[],
    staticProps: readonly any[],
  ): void {
    const { SyntaxKind } = this.ts;
    const baseSyms = erasedBases.map((b) => b.getSymbol?.() ?? b.symbol).filter((s) => s != null);
    if (isInterface) {
      for (const declaringSym of [sym, ...baseSyms]) {
        const declaringType = this.checker.getDeclaredTypeOfSymbol(declaringSym);
        for (const member of declaringType ? this.checker.getPropertiesOfType(declaringType) : []) {
          const memberDecl = (member.valueDeclaration ?? member.declarations?.[0])?.resolve(this.project);
          const ownerId =
            memberDecl?.parent != null
              ? this.checker.getTypeAtLocation(memberDecl.parent)?.getSymbol?.()?.id
              : undefined;
          if (ownerId != null && ownerId === declaringSym.id && this._isInternal(member)) {
            this._validateInternalMember(member, memberDecl);
          }
        }
      }
      return;
    }
    // Classic: the erased bases of a class are its erased base classes, not the erased interfaces it implements.
    const erasedClasses = baseSyms.filter((s) => s.declarations?.[0]?.kind === SyntaxKind.ClassDeclaration);
    const typeHandles: any[] = [sym, ...erasedClasses].flatMap((s) => s.declarations ?? []);
    const typeDecls: any[] = typeHandles.map((h: any) => h.resolve(this.project)).filter((d: any) => d != null);
    // The symbol of each member declaration in these files, from the members `_visitMembers` already read
    // (the symbol of a member named by an identifier). A declaration not found there, such as a base member
    // the type overrides, is looked up.
    const typePaths = new Set(typeHandles.map((h: any) => h.path));
    const symbolsByDecl = new Map<any, any>();
    for (const member of [...instanceProps, ...staticProps]) {
      for (const h of member.declarations ?? []) {
        const memberDecl = typePaths.has(h.path) ? h.resolve(this.project) : undefined;
        if (memberDecl != null && !symbolsByDecl.has(memberDecl)) {
          symbolsByDecl.set(memberDecl, member);
        }
      }
    }
    for (const typeDecl of [decl, ...typeDecls.filter((d) => d !== decl)]) {
      if (typeDecl.kind !== SyntaxKind.ClassDeclaration && typeDecl.kind !== SyntaxKind.InterfaceDeclaration) {
        continue;
      }
      for (const memberDecl of typeDecl.members ?? []) {
        if (
          memberDecl.name == null ||
          memberDecl.kind === SyntaxKind.Constructor ||
          memberDecl.kind === SyntaxKind.IndexSignature
        ) {
          continue;
        }
        const member =
          (memberDecl.name.kind === SyntaxKind.Identifier ? symbolsByDecl.get(memberDecl) : undefined) ??
          this._symbolAtNodeSafe(memberDecl.name);
        if (member != null && this._isInternal(member)) {
          this._validateInternalMember(member, memberDecl);
        }
      }
    }
  }

  private _validateInternalMember(msym: any, memberDecl: any): void {
    const { SyntaxKind } = this.ts;
    const name: string = msym.name;
    if (TS_INTERNAL_SYMBOL_NAMES.has(name) || this._isIgnored(msym)) {
      return;
    }
    // Private identifiers (`#name`; the TypeScript 7 symbol name is `__#1@#name`) and `private` members.
    const first = (msym.valueDeclaration ?? msym.declarations?.[0])?.resolve(this.project) ?? memberDecl;
    if (
      name.startsWith('#') ||
      first?.name?.kind === SyntaxKind.PrivateIdentifier ||
      (first?.modifiers ?? []).some((x: any) => x.kind === SyntaxKind.PrivateKeyword)
    ) {
      return;
    }
    if (!name.startsWith('_')) {
      this._report(JsiiDiagnostic.JSII_8005_INTERNAL_UNDERSCORE, this._nameOrDeclaration(memberDecl), name);
    }
    if (!this._jsDocTags(msym).some((t: any) => t.name === 'internal')) {
      this._report(JsiiDiagnostic.JSII_8006_UNDERSCORE_INTERNAL, this._nameOrDeclaration(memberDecl), name);
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

  /**
   * A member named like its declaring type (classic `_visitMethod` / `_visitProperty`).
   * @returns `false` when the member has a prohibited name and is left out of the type model.
   */
  private _validateMemberName(
    kind: 'method' | 'property',
    msym: any,
    decl: any,
    jsiiType: any,
    declaringTypeDecl: any,
  ): boolean {
    if (jsiiType.name === Case.pascal(msym.name)) {
      this._report(
        JsiiDiagnostic.JSII_5019_MEMBER_TYPE_NAME_CONFLICT,
        decl.name,
        kind,
        msym.name,
        jsiiType,
      ).addRelatedInformationIf(
        this._diagnosticLocation(this._nameOrDeclaration(declaringTypeDecl)),
        `The declaring ${jsiiType.kind} is introduced here`,
      );
    }
    if (isProhibitedMemberName(msym.name)) {
      // Classic: the name of a method, the whole declaration of a property.
      this._report(JsiiDiagnostic.JSII_5016_PROHIBITED_MEMBER_NAME, kind === 'method' ? decl.name : decl, msym.name);
      return false;
    }
    return true;
  }

  private _visitMethod(msym: any, decl: any, isStatic: boolean, jsiiType: any, declaringTypeDecl: any): any {
    const { SyntaxKind } = this.ts;
    const sig = this.checker.getSignatureFromDeclaration(decl);
    if (!this._validateMemberName('method', msym, decl, jsiiType, declaringTypeDecl)) {
      return undefined;
    }
    const m: any = { locationInModule: this._locationOf(decl), name: msym.name };
    this.relatedNodes.set(m, decl);
    this._warnAboutReservedWords(msym.name, decl);
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
      this._verifyConsecutiveOptionals(decl, m.parameters);
      const opt: { optional?: boolean } = {};
      const retType = this.checker.getReturnTypeOfSignature(sig);
      // Promise-returning methods: jsii marks them `async`; `_typeReference` models
      // the resolved type (Promise<string> -> string), like strada.
      if (retType?.getSymbol?.()?.name === 'Promise') {
        m.async = true;
      }
      const ret = this._typeReference(retType, opt, decl.type, decl.type ?? decl.name);
      if (ret) {
        m.returns = opt.optional ? { optional: true, type: ret } : { type: ret };
      }
    }
    this._validatePositionalKeywordConflicts(decl, m.parameters ?? []);
    const d = this._visitMemberDocumentation(msym, decl);
    if (d) {
      m.docs = d;
    }
    return this._withDefaultDocs(m);
  }

  /**
   * When the last parameter is a struct, no other parameter may be named like one
   * of its properties, so that it can be turned into keyword arguments
   * (classic `_visitMethod`).
   */
  private _validatePositionalKeywordConflicts(decl: any, parameters: any[]): void {
    const lastParamType = parameters[parameters.length - 1]?.type;
    if (lastParamType == null || !spec.isNamedTypeReference(lastParamType)) {
      return;
    }
    this.deferred.push(() => {
      const struct = this._dereferenceType(lastParamType.fqn);
      if (struct == null || !spec.isInterfaceType(struct) || !struct.datatype) {
        return;
      }
      const propNames = new Set<string>();
      const seen = new Set<string>();
      const collect = (iface: spec.InterfaceType) => {
        for (const p of iface.properties ?? []) {
          propNames.add(p.name);
        }
        for (const baseFqn of iface.interfaces ?? []) {
          const base = this._dereferenceType(baseFqn);
          if (base != null && spec.isInterfaceType(base) && !seen.has(baseFqn)) {
            seen.add(baseFqn);
            collect(base);
          }
        }
      };
      collect(struct);
      const paramNames = new Set(parameters.slice(0, parameters.length - 1).map((x) => x.name));
      for (const badName of propNames) {
        if (paramNames.has(badName)) {
          this._report(JsiiDiagnostic.JSII_5017_POSITIONAL_KEYWORD_CONFLICT, decl, badName);
        }
      }
    });
  }

  /** A type of this assembly or of a dependency, by fqn. */
  private _dereferenceType(fqn: string): spec.Type | undefined {
    return this.types[fqn] ?? this.externalTypeByFqn.get(fqn);
  }

  private _visitProperty(psym: any, decl: any, isStatic: boolean, jsiiType: any, declaringTypeDecl: any): any {
    const { SyntaxKind } = this.ts;
    if (!this._validateMemberName('property', psym, decl, jsiiType, declaringTypeDecl)) {
      return undefined;
    }
    this._warnAboutReservedWords(psym.name, decl);
    const t = this._typeOfSymbolAt(psym, decl);
    const opt: { optional?: boolean } = {};
    const p: any = {
      locationInModule: this._locationOf(decl),
      name: psym.name,
      type: this._typeReference(t, opt, decl.type, decl.type ?? decl.name),
    };
    this.relatedNodes.set(p, decl);
    const mods = decl.modifiers ?? [];
    const hasSetter = psym.declarations?.some((h: any) => h.kind === SyntaxKind.SetAccessor);
    if (decl.kind === SyntaxKind.GetAccessor && hasSetter) {
      this._checkSeparateWriteType(psym, decl, p.type, opt.optional);
    }
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

  /**
   * Classic: JSII_1005 when a setter's value type (or optionality) differs from the type of its getter. The setter
   * type is converted like any other type reference, so it reports its own diagnostics too.
   */
  private _checkSeparateWriteType(psym: any, getterDecl: any, getterType: any, getterOptional?: boolean): void {
    for (const handle of psym.declarations ?? []) {
      const setterDecl = handle.kind === this.ts.SyntaxKind.SetAccessor ? handle.resolve(this.project) : undefined;
      const valueTypeNode = setterDecl?.parameters?.[0]?.type;
      if (valueTypeNode == null) {
        continue;
      }
      const opt: { optional?: boolean } = {};
      const valueType = this._typeReference(
        this.checker.getTypeFromTypeNode(valueTypeNode),
        opt,
        valueTypeNode,
        valueTypeNode,
      );
      if (
        getterOptional !== opt.optional ||
        spec.describeTypeReference(getterType) !== spec.describeTypeReference(valueType)
      ) {
        this._report(JsiiDiagnostic.JSII_1005_SEPARATE_WRITE_TYPE, valueTypeNode).addRelatedInformationIf(
          this._diagnosticLocation(getterDecl.type ?? getterDecl.name),
          'The getter signature is declared here',
        );
      }
    }
  }

  private _visitParameter(prm: any): any {
    const decl = prm.declarations?.[0]?.resolve(this.project);
    this._warnAboutReservedWords(prm.name, decl);
    const t = decl ? this.checker.getTypeOfSymbolAtLocation(prm, decl) : undefined;
    const opt: { optional?: boolean } = {};
    const p: any = { name: prm.name, type: this._typeReference(t, opt, decl?.type, decl?.type ?? decl?.name) };
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

  /**
   * `typeNode` is the syntax of the type (it gives the union member order);
   * `declaration` is the node jsii diagnostics about the type point at (the
   * classic assembler's `declaration`: the type node of the member, or its name).
   */
  private _typeReference(type: any, optionalOut?: { optional?: boolean }, typeNode?: any, declaration?: any): any {
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
    if (typeof type.isTupleType === 'function' && type.isTupleType()) {
      // Classic: a tuple type has no symbol, so it was modeled as `json`.
      this._report(JsiiDiagnostic.JSII_1999_UNSUPPORTED, declaration, { what: 'Tuple types', alternative: 'arrays' });
      return { primitive: 'json' };
    }
    if (type.isUnionType()) {
      return this._unionTypeReference(type, optionalOut, typeNode, declaration);
    }
    if (typeof type.isIntersectionType === 'function' && type.isIntersectionType()) {
      return this._intersectionTypeReference(type, declaration);
    }
    if (f & TypeFlags.Never) {
      this._report(JsiiDiagnostic.JSII_1007_NEVER_TYPE, declaration);
      return { primitive: 'any' };
    }
    const sym = type.getSymbol();
    if (!sym) {
      // Classic: an object type without a symbol is `json`; anything else (`null`, `undefined`) cannot be modeled.
      if (f & TypeFlags.Object) {
        return { primitive: 'json' };
      }
      if (f & (TypeFlags.ESSymbolLike | TypeFlags.BigIntLike)) {
        // shortcut: classic used their apparent types (Symbol, BigInt) and reported JSII3001; ported with JSII3001.
        return { primitive: 'any' };
      }
      this._report(JsiiDiagnostic.JSII_1001_TYPE_HAS_NO_SYMBOL, declaration);
      return { primitive: 'any' };
    }
    if (this._isArrayType(type)) {
      const args = type.isTypeReference() ? this.checker.getTypeArguments(type) : [];
      if (args.length !== 1) {
        // An array inside an intersection carries the intersection as an extra `this` type argument.
        this._report(
          JsiiDiagnostic.JSII_1003_UNSUPPORTED_TYPE,
          declaration,
          `Array references must have exactly one type argument (found ${args.length || 'none'})`,
        );
        return { collection: { elementtype: { primitive: 'any' }, kind: 'array' } };
      }
      return { collection: { elementtype: this._plainTypeReference(args[0], declaration), kind: 'array' } };
    }
    if (sym.name === '__type') {
      return { collection: { elementtype: this._mapElementType(type, sym, declaration), kind: 'map' } };
    }
    if (sym.name === 'Promise') {
      const args = type.isTypeReference() ? this.checker.getTypeArguments(type) : [];
      if (args.length !== 1) {
        this._report(JsiiDiagnostic.JSII_1002_UNSPECIFIED_PROMISE, declaration);
        return { primitive: 'any' };
      }
      const argNode = typeNode?.kind === this.ts.SyntaxKind.TypeReference ? typeNode.typeArguments?.[0] : undefined;
      return this._plainTypeReference(args[0], declaration, argNode);
    }
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
    const target = type.isTypeReference() ? type.getTarget() : type;
    const tsym = target.getSymbol() ?? sym;
    const fqn = this.typeFqnBySymbolId.get(tsym.id) ?? this._externalFqnOf(tsym);
    if (fqn) {
      return { fqn };
    }
    const indexInfos = this.checker.getIndexInfosOfType(type);
    if (indexInfos.length) {
      return {
        collection: {
          elementtype: this._typeReference(indexInfos[0].valueType, undefined, undefined, declaration),
          kind: 'map',
        },
      };
    }
    return { primitive: 'any' };
  }

  /**
   * Classic `_typeReference`: a type where jsii expects a plain type reference (array and map elements, the type of a
   * promise), so `undefined` in it is a JSII_3999 error rather than an optional value.
   */
  private _plainTypeReference(type: any, declaration: any, typeNode?: any): any {
    const opt: { optional?: boolean } = {};
    const ref = this._typeReference(type, opt, typeNode, declaration);
    if (opt.optional) {
      this._report(
        JsiiDiagnostic.JSII_3999_INCOHERENT_TYPE_MODEL,
        declaration,
        'Encountered optional value in location where a plain type reference is expected',
      );
    }
    return ref;
  }

  /**
   * The element type of an anonymous object type modeled as a map (classic `_mapType`): its string index type, or
   * the value type of a lone template-literal index signature. Anything else is a JSII_1003 error.
   */
  private _mapElementType(type: any, sym: any, declaration: any): any {
    const { SyntaxKind } = this.ts;
    const stringIndexType = type.getStringIndexType();
    if (stringIndexType) {
      return this._plainTypeReference(stringIndexType, declaration);
    }
    const typeDecl = sym.declarations?.[0]?.resolve(this.project);
    const member =
      typeDecl?.kind === SyntaxKind.TypeLiteral && typeDecl.members.length === 1 ? typeDecl.members[0] : undefined;
    if (
      member?.kind === SyntaxKind.IndexSignature &&
      member.parameters[0]?.type?.kind === SyntaxKind.TemplateLiteralType
    ) {
      return this._plainTypeReference(this.checker.getTypeFromTypeNode(member.type), member.type, member.type);
    }
    this._report(JsiiDiagnostic.JSII_1003_UNSUPPORTED_TYPE, declaration, 'Only string-indexed map types are supported');
    return { primitive: 'any' };
  }

  private _unionTypeReference(type: any, optionalOut?: { optional?: boolean }, typeNode?: any, declaration?: any): any {
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
        pushFlat(this._typeReference(tt, optionalOut, tn, declaration));
      }
      if (refs.length === 1) {
        return refs[0];
      }
      if (refs.length > 1) {
        return { union: { types: refs.sort(compareUnionMembers) } };
      }
    }
    const refs: any[] = [];
    const seen = new Set<string>();
    for (const p of parts) {
      const r = this._typeReference(p, optionalOut, undefined, declaration);
      const key = JSON.stringify(r);
      if (r && !seen.has(key)) {
        seen.add(key);
        refs.push(r);
      }
    }
    if (refs.length === 1) {
      return refs[0];
    }
    return { union: { types: refs.sort(compareUnionMembers) } };
  }

  /**
   * Build an intersection type reference (`A & B`), e.g. jsii models
   * `IFooRef & IGrantable` as `{ intersection: { types: [...] } }`. Mirrors
   * strada's `type.isIntersection()` branch: each constituent is turned into a
   * type reference, deduplicated.
   */
  private _intersectionTypeReference(type: any, declaration?: any): any {
    const refs: any[] = [];
    const seen = new Set<string>();
    // Classic: the apparent type of the intersection, whose members carry the intersection as `this` type argument.
    for (const t of this.checker.getApparentType(type).getTypes()) {
      const r = this._typeReference(t, undefined, undefined, declaration);
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
    const ref = { intersection: { types: refs } };
    this._validateIntersectionType(ref, declaration);
    return ref;
  }

  /**
   * Classic `validateIntersectionType`, once all types are known: an intersection may only combine behavioral
   * interfaces (JSII1008), and members they share must be declared the same way (JSII1011).
   */
  private _validateIntersectionType(ref: spec.IntersectionTypeReference, declaration: any): void {
    this.deferred.push(() => {
      const elementTypes = ref.intersection.types
        .filter(spec.isNamedTypeReference)
        .map((t) => this._dereferenceType(t.fqn))
        .filter((t): t is spec.Type => t != null);
      // Classic: nothing is checked when no element is a known named type.
      if (elementTypes.length === 0) {
        return;
      }
      const resolvedFqns = new Set(elementTypes.map((t) => t.fqn));
      const unresolved = [...new Set(ref.intersection.types.map(typeReferenceToString))].filter(
        (x) => !resolvedFqns.has(x),
      );
      if (unresolved.length > 0) {
        this._report(JsiiDiagnostic.JSII_1008_ONLY_INTERFACE_INTERSECTION, declaration, unresolved.join(', '));
      }
      const nonBehavioral = elementTypes.filter((t) => !isBehavioralInterfaceType(t));
      if (nonBehavioral.length > 0) {
        this._report(
          JsiiDiagnostic.JSII_1008_ONLY_INTERFACE_INTERSECTION,
          declaration,
          nonBehavioral.map((t) => t.fqn).join(', '),
        );
      }

      const interfaces = elementTypes.filter(isBehavioralInterfaceType);
      const allProps = new Set(interfaces.flatMap((int) => [...this._allInterfaceMembers(int, 'properties')]));
      const allMethods = new Set(interfaces.flatMap((int) => [...this._allInterfaceMembers(int, 'methods')]));
      for (let i = 1; i < interfaces.length; i++) {
        const int0 = interfaces[0];
        const int1 = interfaces[i];
        for (const prop of allProps) {
          const diff = comparePropForIntersection(
            int0.properties?.find((p) => p.name === prop),
            int1.properties?.find((p) => p.name === prop),
          );
          if (diff) {
            this._report(
              JsiiDiagnostic.JSII_1011_INTERSECTION_MEMBER_DIFFERENT,
              declaration,
              prop,
              int0.name,
              diff[0],
              int1.name,
              diff[1],
            );
          }
        }
        for (const meth of allMethods) {
          const diff = compareMethodForIntersection(
            int0.methods?.find((m) => m.name === meth),
            int1.methods?.find((m) => m.name === meth),
          );
          if (diff) {
            this._report(
              JsiiDiagnostic.JSII_1011_INTERSECTION_MEMBER_DIFFERENT,
              declaration,
              meth,
              int0.name,
              diff[0],
              int1.name,
              diff[1],
            );
          }
        }
      }
    });
  }

  /** The names of the properties or methods of an interface and its base interfaces (classic `allProperties`). */
  private _allInterfaceMembers(root: spec.InterfaceType, kind: 'properties' | 'methods'): Set<string> {
    const names = new Set<string>();
    const recurse = (int: spec.InterfaceType) => {
      for (const member of int[kind] ?? []) {
        names.add(member.name);
      }
      for (const baseFqn of int.interfaces ?? []) {
        const base = this._dereferenceType(baseFqn);
        if (base != null && spec.isInterfaceType(base)) {
          recurse(base);
        }
      }
    };
    recurse(root);
    return names;
  }

  /**
   * Classic `validateTypesAgainstPositions`: intersection types may only be used as inputs (JSII1009). Constructor
   * and method parameters are inputs; properties and method return types are outputs, and so are the properties of
   * the structs they reference.
   */
  private _validateTypesAgainstPositions(): void {
    const validatedFqns = { in: new Set<string>(), out: new Set<string>() };
    const validateRefFor = (dir: 'in' | 'out', typeRef: spec.TypeReference, reason: string): void => {
      visitTypeReference(typeRef, {
        named: (ref) => {
          // Named types are only validated once for every direction
          if (validatedFqns[dir].has(ref.fqn)) {
            return;
          }
          validatedFqns[dir].add(ref.fqn);
          const type = this._dereferenceType(ref.fqn);
          if (type != null && isDataType(type)) {
            for (const prop of type.properties ?? []) {
              validateRefFor(dir, prop.type, `type of property ${type.name}.${prop.name}, ${reason}`);
            }
          }
        },
        primitive: () => {},
        collection: (ref) => validateRefFor(dir, ref.collection.elementtype, reason),
        union: (ref) => {
          for (const t of ref.union.types) {
            validateRefFor(dir, t, reason);
          }
        },
        intersection: (ref) => {
          if (dir === 'out') {
            this._diagnostics.push(JsiiDiagnostic.JSII_1009_INTERSECTION_ONLY_INPUT.createDetached(reason));
          }
          for (const t of ref.intersection.types) {
            validateRefFor(dir, t, reason);
          }
        },
      });
    };

    for (const type of Object.values(this.types)) {
      if (spec.isClassType(type)) {
        for (const ctorParam of type.initializer?.parameters ?? []) {
          validateRefFor('in', ctorParam.type, `a constructor parameter of ${type.name}`);
        }
      }
      if (spec.isClassType(type) || isBehavioralInterfaceType(type)) {
        for (const property of type.properties ?? []) {
          validateRefFor('out', property.type, `type of property ${type.name}.${property.name}`);
        }
        for (const method of type.methods ?? []) {
          for (const param of method.parameters ?? []) {
            validateRefFor('in', param.type, `a parameter of method ${type.name}.${method.name}()`);
          }
          if (method.returns) {
            validateRefFor('out', method.returns.type, `return type of method ${type.name}.${method.name}()`);
          }
        }
      }
    }
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

  /**
   * Report a jsii diagnostic, pointing at `node` (or at no location when
   * `node` is undefined). Pass the name node where one exists, like the
   * classic assembler did. Returns the diagnostic so that related information
   * can be added to it.
   *
   * To port a diagnostic: call `this._report(JsiiDiagnostic.JSII_xxxx_NAME, node, ...args)`
   * where the classic assembler pushed `JsiiDiagnostic.JSII_xxxx_NAME.create(node, ...args)`.
   */
  private _report<T extends DiagnosticMessageFormatter>(
    code: Code<T>,
    node: any | undefined,
    ...args: Parameters<T>
  ): JsiiDiagnostic {
    const diagnostic = code.create(this._diagnosticLocation(node), ...args);
    if (diagnostic.category === DiagnosticCategory.Warning && this._isSuppressed(node, diagnostic.jsiiCode)) {
      suppressInline(diagnostic);
    }
    this._diagnostics.push(diagnostic);
    return diagnostic;
  }

  /** The source range of `node`, for use as a related-information location. */
  private _diagnosticLocation(node: any | undefined): DiagnosticLocation | undefined {
    const sf = node?.getSourceFile?.();
    if (sf == null) {
      return undefined;
    }
    const start: number = node.getStart(sf);
    return { file: { fileName: sf.fileName, text: this._sourceTextOf(sf) }, start, length: node.end - start };
  }

  /** The name node of a declaration, or the declaration itself when it has none. */
  private _nameOrDeclaration(decl: any): any {
    return decl?.name ?? decl;
  }

  /**
   * The naming conventions the classic validator checked on the finished
   * assembly, in its order: enum members (JSII8001), then members (JSII8002),
   * then static constants (JSII8003). Members are all methods, then all
   * properties, type by type.
   */
  private _validateNames(assembly: spec.Assembly): void {
    const types = Object.values(assembly.types ?? {});
    const members = [
      ...types.flatMap((type) =>
        spec.isClassOrInterfaceType(type) ? (type.methods ?? []).map((member) => ({ member, type })) : [],
      ),
      ...types.flatMap((type) =>
        spec.isClassOrInterfaceType(type)
          ? (type.properties ?? []).map((member: spec.Property | spec.Method) => ({ member, type }))
          : [],
      ),
    ];
    const memberNameNode = (member: object) => this._nameOrDeclaration(this.relatedNodes.get(member));

    for (const type of types) {
      if (!spec.isEnumType(type)) {
        continue;
      }
      const enumDecl = this.relatedNodes.get(type);
      for (const member of type.members) {
        if (member.name && !isConstantCase(member.name)) {
          const memberDecl = (enumDecl?.members ?? []).find(
            (m: any) => m.name?.kind === this.ts.SyntaxKind.Identifier && m.name.text === member.name,
          );
          this._report(
            JsiiDiagnostic.JSII_8001_ALL_CAPS_ENUM_MEMBERS,
            memberDecl?.name ?? this._nameOrDeclaration(enumDecl),
            member.name,
            type.fqn,
          );
        }
      }
    }

    for (const { member, type } of members) {
      if (member.static && (member as spec.Property).const) {
        continue;
      }
      if (member.name && member.name !== Case.camel(member.name)) {
        this._report(JsiiDiagnostic.JSII_8002_CAMEL_CASED_MEMBERS, memberNameNode(member), member.name, type.fqn);
      }
    }

    for (const { member, type } of members) {
      if (!member.static || !(member as spec.Property).const) {
        continue;
      }
      if (
        member.name &&
        !isConstantCase(member.name) &&
        member.name !== Case.pascal(member.name) &&
        member.name !== Case.camel(member.name)
      ) {
        this._report(JsiiDiagnostic.JSII_8003_STATIC_CONST_CASING, memberNameNode(member), member.name, type.name);
      }
    }
  }

  private _warnAboutReservedWords(name: string, decl: any) {
    const reservingLanguages = isReservedName(name);
    if (reservingLanguages) {
      // A parameter property is visited as a parameter and as a property, at the same node. The classic
      // compiler dropped the duplicate (identical node and message), so it is reported once here.
      const node = this._nameOrDeclaration(decl);
      const location = this._diagnosticLocation(node);
      const key = location && `${location.file.fileName}:${location.start}:${name}`;
      if (key != null && this.reservedWordReports.has(key)) {
        return;
      }
      if (key != null) {
        this.reservedWordReports.add(key);
      }
      this._report(JsiiDiagnostic.JSII_5018_RESERVED_WORD, node, name, reservingLanguages);
    }
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

/** The values of TypeScript's `InternalSymbolName` (classic `isInternalSymbol`). */
const TS_INTERNAL_SYMBOL_NAMES = new Set([
  '__call',
  '__constructor',
  '__new',
  '__index',
  '__export',
  '__global',
  '__missing',
  '__type',
  '__object',
  '__jsxAttributes',
  '__class',
  '__function',
  '__computed',
  '__resolving__',
  'export=',
  'default',
  'this',
  '__instantiationExpression',
  '__importAttributes',
]);

/** Member names that conflict with synthetic declarations in some languages (classic `PROHIBITED_MEMBER_NAMES`). */
const PROHIBITED_MEMBER_NAMES = ['build', 'equals', 'hashcode'];

/** Port of the classic Assembler's `isProhibitedMemberName`. */
function isProhibitedMemberName(name: string) {
  return PROHIBITED_MEMBER_NAMES.includes(name.toLowerCase());
}

/** Port of the classic validator's `isConstantCase`: only uppercase characters, digits and underscores. */
function isConstantCase(x: string) {
  return !/[^A-Z0-9_]/.exec(x);
}

/** Port of the classic Assembler's `noEmptyDict`. */
/** The members of a type by name; a method wins over a property of the same name (classic `typeMembers`). */
function typeMembers(jsiiType: spec.InterfaceType | spec.ClassType): Record<string, spec.Property | spec.Method> {
  const ret: Record<string, spec.Property | spec.Method> = {};
  for (const prop of jsiiType.properties ?? []) {
    ret[prop.name] = prop;
  }
  for (const method of jsiiType.methods ?? []) {
    ret[method.name ?? ''] = method;
  }
  return ret;
}

/** Whether an interface member re-declares a base member with exactly the same shape (classic). */
function isIdenticalRedeclaration(
  member: spec.Property | spec.Method,
  baseMember: spec.Property | spec.Method,
): boolean {
  // Not `spec.isMethod`: it only tells methods from initializers and is true for properties too.
  if (!spec.isProperty(member) && !spec.isProperty(baseMember)) {
    const params = member.parameters ?? [];
    const baseParams = baseMember.parameters ?? [];
    return (
      !!member.static === !!baseMember.static &&
      !!member.async === !!baseMember.async &&
      deepEqual(member.returns, baseMember.returns) &&
      params.length === baseParams.length &&
      params.every(
        (param, i) =>
          deepEqual(param.type, baseParams[i].type) &&
          !!param.optional === !!baseParams[i].optional &&
          !!param.variadic === !!baseParams[i].variadic,
      )
    );
  }
  if (spec.isProperty(member) && spec.isProperty(baseMember)) {
    return (
      !!member.static === !!baseMember.static &&
      !!member.optional === !!baseMember.optional &&
      !!member.immutable === !!baseMember.immutable &&
      deepEqual(member.type, baseMember.type)
    );
  }
  return false;
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

function comparePropForIntersection(
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

function compareMethodForIntersection(
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
      cmpDesc(p1.variadic, p2.variadic, (v) => (v ? `parameter ${i + 1} variadic` : `parameter ${i + 1} not variadic`));
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

function cmpDesc<T>(a: T, b: T, desc: (x: T) => string): [string, string] | undefined {
  const desc1 = desc(a);
  const desc2 = desc(b);
  return desc1 !== desc2 ? [desc1, desc2] : undefined;
}

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
