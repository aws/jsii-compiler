/*
 * ---------------------------------------------------------------------------
 * --strip-deprecated in the emitted `.d.ts` files. The previous implementation
 * changed the declarations with an `afterDeclarations` transformer (its
 * `DeprecationRemovalTransformer`); the TypeScript 7 API has no transformer
 * hook, so this is a post-emit text pass that produces the same text. The
 * `.js` files are not changed, as before.
 *
 * The assembler decides what goes (the declarations with an `@deprecated` tag
 * that it stripped from the assembly) and how heritage clauses change; this
 * file finds the same nodes in the emitted `.d.ts` and edits its text.
 * ---------------------------------------------------------------------------
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Insertion, insertIntoEmittedJs } from './source-map';
import { TypeScriptApi, TypeScriptProject } from '../compiler-host';
import { JsiiError } from '../utils';

/** A type a heritage clause refers to: one of this assembly (its declaration), or one of another assembly. */
export type HeritageReference = { readonly declaration: any } | { readonly fqn: string };

/** A change to the heritage clauses of a class or interface (`target`, its declaration). */
export type HeritageTransformation = { readonly target: any } & (
  | { readonly kind: 'replaceBase'; readonly type: HeritageReference }
  | { readonly kind: 'removeBase' }
  | { readonly kind: 'addInterface'; readonly type: HeritageReference }
  /** `types` are the (source) heritage types to remove. */
  | { readonly kind: 'removeInterface'; readonly types: readonly any[] }
);

/** What --strip-deprecated changes in the `.d.ts` files. */
export interface DeclarationsStripping {
  /** The declarations (handles) of the stripped types and members; only those with an `@deprecated` tag go. */
  readonly declarations: readonly any[];
  /** In the order they are applied. */
  readonly transformations: readonly HeritageTransformation[];
}

/** A heritage type in a rewritten clause: its text, or the generated name it starts with. */
interface HeritageEntry {
  readonly text?: string;
  /** The position of the type in the clauses of the `.d.ts`, `clause:type`. */
  readonly original?: string;
  readonly unique?: UniqueName;
  readonly tail?: string;
}

/** A name the TypeScript printer made unique in the file (`factory.createUniqueName`). */
interface UniqueName {
  readonly base: string;
  /** The module of the `import * as <name>` added for it, if one is added. */
  readonly importFrom?: string;
  name?: string;
}

/** The error of the classic compiler for an interface merged with a class whose base class is stripped. */
export class MergedDeclarationError extends JsiiError {
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, MergedDeclarationError.prototype);
  }
}

/** Applies a `DeclarationsStripping` to the emitted `.d.ts` files. */
export class DeclarationsStripper {
  private prepared?: {
    readonly removed: Set<any>;
    readonly removedKeys: Set<string>;
    readonly removedTypeNames: Set<string>;
    /** Matches any of `removedTypeNames` (to skip the files that cannot import one). */
    readonly removedTypeName?: RegExp;
    readonly byFile: Map<string, { removed: any[]; transformations: HeritageTransformation[] }>;
  };

  public constructor(
    private readonly ts: TypeScriptApi,
    private readonly project: TypeScriptProject,
    private readonly stripping: DeclarationsStripping,
  ) {}

  /** Rewrites the `.d.ts` file emitted for `tsFile` on disk. */
  public apply(dtsFile: string, tsFile: string): void {
    const { removed, removedKeys, removedTypeNames, removedTypeName, byFile } = this.prepare();
    const own = byFile.get(path.resolve(tsFile));
    const dtsText = fs.readFileSync(dtsFile, 'utf8');
    const reExports = /^export\b[^;]*\bfrom\b/m.test(dtsText);
    const imports = /^import\b/m.test(dtsText) && removedTypeName != null && removedTypeName.test(dtsText);
    if (own == null && !reExports && !imports) {
      return;
    }
    const mapComment = /\n\/\/# sourceMappingURL=[^\n]*\s*$/.exec(dtsText);
    const retained = this.project.api.createSourceFile(
      dtsFile,
      mapComment != null ? dtsText.slice(0, mapComment.index) : dtsText,
    );
    try {
      const dts = retained.sourceFile;
      const tsSource = this.project.program.getSourceFile(tsFile);
      if (tsSource == null) {
        return;
      }
      const edits: Insertion[] = [];
      const removedHere = new Set<any>();
      for (const decl of own?.removed ?? []) {
        const node = this.locate(dts, decl);
        if (node != null) {
          removedHere.add(node);
        }
      }
      edits.push(...this.removals(dtsText, dts, removedHere));
      edits.push(...this.heritage(dtsText, dts, tsSource, own?.transformations ?? [], removedHere, removed));
      if (imports) {
        edits.push(...this.imports(dtsText, dts, tsSource, removedTypeNames, removedKeys));
      }
      if (reExports) {
        edits.push(...this.reExports(dtsText, dts, tsSource, removedKeys));
      }
      if (edits.length > 0) {
        fs.writeFileSync(dtsFile, insertIntoEmittedJs(dtsFile, dtsText, edits), 'utf8');
      }
    } finally {
      retained.dispose();
    }
  }

  private prepare(): NonNullable<DeclarationsStripper['prepared']> {
    if (this.prepared != null) {
      return this.prepared;
    }
    const k = this.ts.SyntaxKind;
    const removed = new Set<any>();
    const removedKeys = new Set<string>();
    const removedTypeNames = new Set<string>();
    const byFile = new Map<string, { removed: any[]; transformations: HeritageTransformation[] }>();
    const forFile = (node: any) => {
      const fileName = path.resolve(node.getSourceFile().fileName);
      if (!byFile.has(fileName)) {
        byFile.set(fileName, { removed: [], transformations: [] });
      }
      return byFile.get(fileName)!;
    };
    const seen = new Set<string>();
    for (const handle of this.stripping.declarations) {
      const key = `${handle.path}:${handle.index}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const node = handle.resolve(this.project);
      // Classic: only a declaration with an `@deprecated` tag of its own is removed.
      if (node == null || !hasDeprecatedTag(node)) {
        continue;
      }
      removed.add(node);
      removedKeys.add(key);
      if ([k.ClassDeclaration, k.InterfaceDeclaration, k.EnumDeclaration].includes(node.kind) && node.name != null) {
        removedTypeNames.add(node.name.text);
      }
      forFile(node).removed.push(node);
    }
    for (const transformation of this.stripping.transformations) {
      forFile(transformation.target).transformations.push(transformation);
    }
    const removedTypeName =
      removedTypeNames.size > 0 ? new RegExp(`\\b(?:${[...removedTypeNames].join('|')})\\b`) : undefined;
    this.prepared = { removed, removedKeys, removedTypeNames, removedTypeName, byFile };
    return this.prepared;
  }

  /**
   * The node of the `.d.ts` emitted for a declaration of the `.ts` file: the declaration of the same kind and name,
   * in the namespaces, classes and interfaces of the same names.
   */
  private locate(dts: any, decl: any): any {
    const k = this.ts.SyntaxKind;
    const chain: any[] = [];
    for (let node = decl; node != null && node.kind !== k.SourceFile; node = node.parent) {
      if (node.kind !== k.ModuleBlock) {
        chain.unshift(node);
      }
    }
    let scope: any = dts;
    for (const node of chain) {
      const children: any[] =
        scope.kind === k.SourceFile
          ? scope.statements
          : scope.kind === k.ModuleDeclaration
          ? scope.body?.statements ?? []
          : scope.members ?? [];
      scope = children.find((child) => sameDeclaration(child, node, k));
      if (scope == null) {
        return undefined;
      }
    }
    return scope;
  }

  /** Removes the nodes (whole lines, with their leading JSDoc), and the separator of a removed enum member. */
  private removals(text: string, dts: any, nodes: Set<any>): Insertion[] {
    const k = this.ts.SyntaxKind;
    const edits: Insertion[] = [];
    const enums = new Set<any>();
    for (const node of nodes) {
      if (node.kind === k.EnumMember) {
        enums.add(node.parent);
        continue;
      }
      if ([...ancestors(node)].some((a) => nodes.has(a))) {
        continue;
      }
      const start = lineStart(text, leadingStart(text, node, dts));
      const end = lineEnd(text, node.end);
      edits.push({ offset: start, length: end - start, text: '' });
    }
    for (const decl of enums) {
      if ([...ancestors(decl)].some((a) => nodes.has(a)) || nodes.has(decl)) {
        continue;
      }
      const members: any[] = [...decl.members];
      const kept = members.filter((m) => !nodes.has(m));
      const start = members[0].pos;
      const end = members[members.length - 1].end;
      const printed = kept.map((m) => `\n${text.slice(lineStart(text, leadingStart(text, m, dts)), m.end)}`).join(',');
      edits.push({ offset: start, length: end - start, text: printed });
    }
    return edits;
  }

  /** Rewrites the heritage clauses of the classes and interfaces the transformations target. */
  private heritage(
    text: string,
    dts: any,
    tsSource: any,
    transformations: readonly HeritageTransformation[],
    removedHere: Set<any>,
    removed: Set<any>,
  ): Insertion[] {
    if (transformations.length === 0) {
      return [];
    }
    const k = this.ts.SyntaxKind;
    // Classic: the transformer visits the declarations in order and applies the transformations that target each.
    const targets = new Map<any, { source: any; transformations: HeritageTransformation[] }>();
    for (const transformation of transformations) {
      if (removed.has(transformation.target)) {
        continue;
      }
      const located = this.locate(dts, transformation.target);
      if (located == null) {
        continue;
      }
      // Classic: a transformation applies to every class and interface of the same name (declaration merging).
      const scope: any[] = located.parent.statements ?? [];
      for (const node of scope.filter(
        (n) => [k.ClassDeclaration, k.InterfaceDeclaration].includes(n.kind) && n.name?.text === located.name.text,
      )) {
        if (removedHere.has(node) || [...ancestors(node)].some((a) => removedHere.has(a))) {
          continue;
        }
        if (!targets.has(node)) {
          targets.set(node, { source: node === located ? transformation.target : undefined, transformations: [] });
        }
        targets.get(node)!.transformations.push(transformation);
      }
    }
    const ordered = [...targets.entries()].sort(([l], [r]) => l.pos - r.pos);
    const contextModule = withoutExtension(path.resolve(tsSource.fileName));
    const uniqueNames: UniqueName[] = [];
    const rewritten: Array<{ node: any; clauses: Array<{ token: number; types: HeritageEntry[] }> }> = [];
    for (const [node, { source, transformations: own }] of ordered) {
      // shortcut: the heritage types removed from a merged declaration are found in the targeted one only; find
      // them in the merged declaration too if that ever matters.
      const sourceIndex = new Map<any, string>();
      for (const [ci, clause] of (source?.heritageClauses ?? []).entries()) {
        for (const [ti, t] of clause.types.entries()) {
          sourceIndex.set(t, `${ci}:${ti}`);
        }
      }
      let clauses: Array<{ token: number; types: HeritageEntry[] }> = (node.heritageClauses ?? []).map(
        (clause: any, ci: number) => ({
          token: clause.token,
          types: clause.types.map((t: any, ti: number) => ({
            text: text.slice(t.getStart(dts), t.end),
            original: `${ci}:${ti}`,
          })),
        }),
      );
      for (const transformation of own) {
        if (node.kind !== k.ClassDeclaration && ['replaceBase', 'removeBase'].includes(transformation.kind)) {
          // @TODO(NEXT): the classic compiler failed on the interface merged with a class whose base class it
          // replaced (aws/jsii-compiler#3012). After 7.1's first release: leave the interface alone.
          throw new MergedDeclarationError('Expected a ClassDeclaration, found a InterfaceDeclaration');
        }
        switch (transformation.kind) {
          case 'replaceBase': {
            const existing = clauses.find((c) => c.token === k.ExtendsKeyword);
            const entry = this.reference(transformation.type, contextModule, false);
            clauses = [...clauses.filter((c) => c !== existing), { token: k.ExtendsKeyword, types: [entry] }];
            if (entry.unique != null) {
              uniqueNames.push(entry.unique);
            }
            break;
          }
          case 'removeBase':
            clauses = clauses.filter((c) => c.token !== k.ExtendsKeyword);
            break;
          case 'addInterface': {
            const token = node.kind === k.ClassDeclaration ? k.ImplementsKeyword : k.ExtendsKeyword;
            const existing = clauses.find((c) => c.token === token);
            const entry = this.reference(transformation.type, contextModule, true);
            clauses = [...clauses.filter((c) => c !== existing), { token, types: [...(existing?.types ?? []), entry] }];
            if (entry.unique != null) {
              uniqueNames.push(entry.unique);
            }
            break;
          }
          case 'removeInterface': {
            const gone = new Set(transformation.types.map((t) => sourceIndex.get(t)));
            clauses = clauses.flatMap((c) => {
              const types = c.types.filter((t) => t.original == null || !gone.has(t.original));
              return types.length === c.types.length ? [c] : types.length === 0 ? [] : [{ ...c, types }];
            });
            break;
          }
        }
      }
      rewritten.push({ node, clauses });
    }

    // The printer names the imports it adds first (they come first), then the other names in the order of the text.
    const taken = identifiersOf(
      typeof tsSource.text === 'string' ? tsSource.text : fs.readFileSync(tsSource.fileName, 'utf8'),
    );
    const nameOf = (unique: UniqueName) => {
      // Classic `makeUniqueName`: `<base>_<n>`, the first n that no identifier of the source file has.
      const base = unique.base.endsWith('_') ? unique.base : `${unique.base}_`;
      let n = 1;
      while (taken.has(`${base}${n}`)) {
        n++;
      }
      unique.name = `${base}${n}`;
      taken.add(unique.name);
    };
    const withImport = uniqueNames.filter((u) => u.importFrom != null);
    for (const unique of [...withImport, ...uniqueNames.filter((u) => u.importFrom == null)]) {
      nameOf(unique);
    }

    const edits: Insertion[] = [];
    if (withImport.length > 0) {
      edits.push({
        offset: statementsStart(text, dts),
        text: withImport.map((u) => `import * as ${u.name} from ${JSON.stringify(u.importFrom)};\n`).join(''),
      });
    }
    for (const { node, clauses } of rewritten) {
      const printed = clauses
        .map(
          (c) =>
            `${c.token === k.ExtendsKeyword ? 'extends' : 'implements'} ${c.types
              .map((t) => t.text ?? `${t.unique!.name}${t.tail}`)
              .join(', ')}`,
        )
        .join(' ');
      const typeParameters: any[] = node.typeParameters ?? [];
      const start =
        typeParameters.length > 0
          ? text.indexOf('>', typeParameters[typeParameters.length - 1].end) + 1
          : node.name.end;
      const existing: any[] = node.heritageClauses ?? [];
      const end = existing.length > 0 ? existing[existing.length - 1].end : start;
      edits.push({ offset: start, length: end - start, text: printed !== '' ? ` ${printed}` : '' });
    }
    return edits;
  }

  /**
   * Classic `Transformation.typeReference`: how a type is named in a heritage clause of the context module.
   *
   * @TODO(NEXT): the classic compiler added the `import * as` only for an added interface, not for a replaced base
   * class, so the name of the base class is not declared (aws/jsii-compiler#2957). After 7.1's first release: add it
   * for both (`addsImport` always).
   */
  private reference(type: HeritageReference, contextModule: string, addsImport: boolean): HeritageEntry {
    if ('fqn' in type) {
      const [root, ...tail] = type.fqn.split('.');
      return {
        unique: { base: root, importFrom: addsImport ? root : undefined },
        tail: tail.map((t) => `.${t}`).join(''),
      };
    }
    const k = this.ts.SyntaxKind;
    const names: string[] = [];
    for (let node = type.declaration; node != null && node.kind !== k.SourceFile; node = node.parent) {
      if (node.kind !== k.ModuleBlock && node.name != null) {
        names.unshift(node.name.text);
      }
    }
    const typeModule = withoutExtension(path.resolve(type.declaration.getSourceFile().fileName));
    if (typeModule === contextModule) {
      return { text: names.join('.') };
    }
    return {
      unique: {
        base: path.basename(typeModule),
        importFrom: addsImport ? `./${path.relative(path.dirname(contextModule), typeModule)}` : undefined,
      },
      tail: names.map((n) => `.${n}`).join(''),
    };
  }

  /** Classic: the named imports of a removed type are removed; an import that names nothing is kept for its effects. */
  private imports(
    text: string,
    dts: any,
    tsSource: any,
    removedTypeNames: Set<string>,
    removedKeys: Set<string>,
  ): Insertion[] {
    const k = this.ts.SyntaxKind;
    // shortcut: only the imports named like a removed type are looked up (an import of a type re-exported under
    // another name is not); look them all up if that ever matters.
    const candidates: any[] = [];
    for (const statement of tsSource.statements) {
      const bindings = statement.kind === k.ImportDeclaration ? statement.importClause?.namedBindings : undefined;
      if (bindings?.kind !== k.NamedImports) {
        continue;
      }
      for (const element of bindings.elements) {
        if (removedTypeNames.has((element.propertyName ?? element.name).text)) {
          candidates.push(element);
        }
      }
    }
    if (candidates.length === 0) {
      return [];
    }
    const checker = this.project.checker;
    const removedNames = new Set<string>();
    const symbols: any[] = checker.getSymbolAtLocation(candidates.map((e) => e.name));
    for (const [i, element] of candidates.entries()) {
      const target = symbols[i] != null ? checker.getAliasedSymbol(symbols[i]) : undefined;
      if ((target?.declarations ?? []).some((d: any) => removedKeys.has(`${d.path}:${d.index}`))) {
        removedNames.add(element.name.text);
      }
    }
    const edits: Insertion[] = [];
    for (const statement of dts.statements) {
      const clause = statement.kind === k.ImportDeclaration ? statement.importClause : undefined;
      if (clause?.namedBindings?.kind !== k.NamedImports) {
        continue;
      }
      const elements: any[] = [...clause.namedBindings.elements];
      const kept = elements.filter((e) => !removedNames.has(e.name.text));
      if (kept.length === elements.length) {
        continue;
      }
      const specifier = text.slice(statement.moduleSpecifier.getStart(dts), statement.moduleSpecifier.end);
      const printed =
        clause.name != null || kept.length > 0
          ? `import ${clause.isTypeOnly ? 'type ' : ''}${clause.name != null ? `${clause.name.text}, ` : ''}${braces(
              kept.map((e) => text.slice(e.getStart(dts), e.end)),
            )} from ${specifier};`
          : `import ${specifier};`;
      const start = statement.getStart(dts);
      edits.push({ offset: start, length: statement.end - start, text: printed });
    }
    return edits;
  }

  /**
   * Classic: an `export ... from` that exports nothing any more becomes an `import` (for its effects), and the names
   * of a removed type are removed from an `export { ... } from`.
   */
  private reExports(text: string, dts: any, tsSource: any, removedKeys: Set<string>): Insertion[] {
    const k = this.ts.SyntaxKind;
    const isReExport = (s: any) => s.kind === k.ExportDeclaration && s.moduleSpecifier != null;
    const sources: any[] = tsSource.statements.filter(isReExport);
    const emitted: any[] = dts.statements.filter(isReExport);
    if (sources.length !== emitted.length) {
      return [];
    }
    const checker = this.project.checker;
    const modules: any[] = checker.getSymbolAtLocation(sources.map((s) => s.moduleSpecifier));
    const edits: Insertion[] = [];
    for (const [i, statement] of emitted.entries()) {
      if (modules[i] == null) {
        continue;
      }
      const exports = (checker.getExportsOfModule(modules[i]) as any[]).filter(
        (sym) => !(sym.declarations ?? []).some((d: any) => removedKeys.has(`${d.path}:${d.index}`)),
      );
      const specifier = text.slice(statement.moduleSpecifier.getStart(dts), statement.moduleSpecifier.end);
      const start = statement.getStart(dts);
      const clause = statement.exportClause;
      if ((clause == null || clause.kind === k.NamespaceExport) && exports.length === 0) {
        edits.push({ offset: start, length: statement.end - start, text: `import ${specifier};` });
        continue;
      }
      if (clause?.kind !== k.NamedExports) {
        continue;
      }
      // @TODO(NEXT): the classic compiler kept the elements by their exported name, so it also removed
      // `X as Y` when `X` is not removed (aws/jsii-compiler#3126). After 7.1's first release: keep them by the name
      // they export from the module (`propertyName ?? name`).
      const names = new Set(exports.map((sym) => sym.name));
      const elements: any[] = [...clause.elements];
      const kept = elements.filter((e) => names.has(e.name.text));
      if (kept.length !== elements.length) {
        edits.push({
          offset: start,
          length: statement.end - start,
          text: `export ${statement.isTypeOnly ? 'type ' : ''}${braces(
            kept.map((e) => text.slice(e.getStart(dts), e.end)),
          )} from ${specifier};`,
        });
      }
    }
    return edits;
  }
}

/** Whether two declarations (of the `.ts` and of the `.d.ts`) are the same: same kind, name and staticness. */
function sameDeclaration(emitted: any, source: any, k: any): boolean {
  if (emitted.kind !== source.kind || emitted.name?.text == null || emitted.name.text !== source.name?.text) {
    return false;
  }
  const isStatic = (n: any) => (n.modifiers ?? []).some((m: any) => m.kind === k.StaticKeyword);
  return isStatic(emitted) === isStatic(source);
}

/** Whether a declaration has a JSDoc block of its own with an `@deprecated` tag (classic `ts.getJSDocTags`). */
function hasDeprecatedTag(node: any): boolean {
  const sf = node.getSourceFile();
  const text: string = typeof sf.text === 'string' ? sf.text : fs.readFileSync(sf.fileName, 'utf8');
  const leading = text.slice(node.pos, node.getStart(sf));
  return (leading.match(/\/\*\*[\s\S]*?\*\//g) ?? []).some((block) =>
    block
      .replace(/^\/\*\*/, '')
      .replace(/\*\/$/, '')
      .split('\n')
      .some((line) => /^\s*\*?\s*@deprecated\b/.test(line)),
  );
}

function* ancestors(node: any): Generator<any> {
  for (let parent = node.parent; parent != null; parent = parent.parent) {
    yield parent;
  }
}

/** Where the leading JSDoc of a node of the `.d.ts` starts (the node itself when it has none). */
function leadingStart(text: string, node: any, dts: any): number {
  const start = node.getStart(dts);
  const jsDoc = text.slice(node.pos, start).indexOf('/**');
  return jsDoc >= 0 ? node.pos + jsDoc : start;
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

/** The offset after the line break that ends the line of `offset`. */
function lineEnd(text: string, offset: number): number {
  const newline = text.indexOf('\n', offset);
  return newline < 0 ? text.length : newline + 1;
}

/** Where the statements of a `.d.ts` start: after its `/// <reference ... />` directives. */
function statementsStart(text: string, dts: any): number {
  const first = dts.statements[0];
  return first != null ? lineStart(text, leadingStart(text, first, dts)) : 0;
}

/** `{ a, b }`, or `{}`, as the printer lays out named imports and exports. */
function braces(elements: readonly string[]): string {
  return elements.length > 0 ? `{ ${elements.join(', ')} }` : '{}';
}

/** A file name without its TypeScript extension (as in the fully qualified name of a module). */
function withoutExtension(fileName: string): string {
  return fileName.replace(/(\.d)?\.[cm]?tsx?$/, '');
}

/**
 * The identifiers of a source file, which the names the printer makes up must not be.
 *
 * shortcut: every word of the text, comments and strings included, so a made-up name may skip a number the printer
 * would have used; parse the file if that ever matters.
 */
function identifiersOf(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);
}
