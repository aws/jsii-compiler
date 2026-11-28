/*
 * ---------------------------------------------------------------------------
 * jsii runtime type information (rtti) in the emitted `.js`.
 *
 * The classic compiler added it with a TypeScript transformer (main:
 * src/transforms/runtime-info.ts, `RuntimeTypeInfoInjector`): a
 * `const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");` at the top of the file
 * and, as the first member of each jsii class,
 * `static [JSII_RTTI_SYMBOL_1] = { fqn: "...", version: "..." };`.
 * TypeScript 7 has no transformer hook, so the same code is spliced into the
 * emitted text after emit, where the TypeScript 6 printer put it, in the form
 * TypeScript 6 turned that static into for the compilation's target (see
 * `RttiForm`).
 * ---------------------------------------------------------------------------
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { dropCommentsBeforeClose, EmittedFile, indentationAt, skipWhitespace } from './emitted-js';
import { Insertion } from './source-map';

// @TODO(NEXT): the rtti form (a `static [JSII_RTTI_SYMBOL_1]` member spliced into the emitted text) copies TS6's
// transformer output, and needs text surgery because TS7 has no transformers. After 7.1's first release: settle on
// one form (e.g. the `Object.defineProperty` statements of `rttiSnippet`) and drop the splicing.
const RTTI_SYMBOL_NAME = 'JSII_RTTI_SYMBOL';
/** `ScriptTarget.ES2022`: the first target with native class fields and static blocks. */
const ES2022 = 9;

/**
 * The code TypeScript 6 emitted for the transformer's `static [JSII_RTTI_SYMBOL_1] = {...}`:
 *
 * - `field`: kept as is (`useDefineForClassFields`, the default from ES2022);
 * - `staticBlocks`: without `useDefineForClassFields` on ES2022 and later,
 *   `static { _a = JSII_RTTI_SYMBOL_1; }` and `static { this[_a] = {...}; }`;
 * - `assignments`: before ES2022 (without `useDefineForClassFields`),
 *   `_a = JSII_RTTI_SYMBOL_1;` and `Foo[_a] = {...};` after the class;
 * - `defineProperty`: before ES2022 with `useDefineForClassFields`,
 *   `_a = JSII_RTTI_SYMBOL_1;` and `Object.defineProperty(Foo, _a, {...});` after the class.
 *
 * The temporary `_a` is declared by a `var` at the top of its scope.
 */
export type RttiForm = 'field' | 'staticBlocks' | 'assignments' | 'defineProperty';

/** The `RttiForm` for the compiler options of the program. */
export function rttiForm(options: { target?: number; useDefineForClassFields?: boolean }): RttiForm {
  const target = options.target ?? Number.MAX_SAFE_INTEGER;
  const defineFields = options.useDefineForClassFields ?? target >= ES2022;
  if (target >= ES2022) {
    return defineFields ? 'field' : 'staticBlocks';
  }
  return defineFields ? 'defineProperty' : 'assignments';
}

/**
 * The rtti edits for one emitted file, and the statement declaring the rtti
 * symbol to put at its top when any class got rtti.
 *
 * @param fqnByName the fqn of each jsii class of the file, by in-file name
 */
export function rttiInsertions(
  file: EmittedFile,
  fqnByName: ReadonlyMap<string, string>,
  version: string,
  compilerOptions: { target?: number; useDefineForClassFields?: boolean } = {},
): { readonly edits: Insertion[]; readonly prepend?: string } {
  const { jsText, jsSource } = file;
  const form = rttiForm(compilerOptions);
  const symbol = uniqueName(file);
  // Only the forms that need a temporary look for the emit's own (a walk over the whole emitted file).
  let temporaries: Temporaries | undefined;
  const temps = () => (temporaries ??= new Temporaries(file));
  const edits: Insertion[] = [];
  const annotated: Array<{ jsClass: any; offset: number; indent: string; info: string }> = [];
  for (const { ts: tsClass, js: jsClass, qualifiedName } of file.classes) {
    const fqn = qualifiedName != null ? fqnByName.get(qualifiedName) : undefined;
    if (fqn == null || tsClass.kind !== file.k.ClassDeclaration) {
      continue;
    }
    const members: any = jsClass.members;
    const close = jsClass.end - 1;
    const indent = `${indentationAt(jsText, jsClass.getStart(jsSource))}    `;
    // The member list was replaced, so the printer lost the comments before the closing `}`.
    // @TODO(NEXT): a TypeScript 6 side effect (see dropCommentsBeforeClose); keep them after 7.1's first release.
    edits.push(...dropCommentsBeforeClose(jsText, members, members.pos, close, `\n${indentationAt(jsText, close)}`));
    // The static was the first member when the TypeScript transforms ran, and they put their own members
    // before it: the static blocks of ES decorators, then the fields of parameter properties.
    const skip = addedLeadingMembers(tsClass, members, file.k);
    const madeUp = members[0]?.kind === file.k.Constructor && !hasConstructor(tsClass, file.k) ? members[0] : undefined;
    if (madeUp?.body != null) {
      // The emit moves the comments before the class's `}` into the constructor it made up; they were lost too.
      // @TODO(NEXT): a TypeScript 6 side effect; keep them after 7.1's first release.
      const body = madeUp.body;
      const replacement = `\n${indentationAt(jsText, madeUp.getStart(jsSource))}`;
      edits.push(
        ...dropCommentsBeforeClose(jsText, body.statements, body.getStart(jsSource) + 1, body.end - 1, replacement),
      );
    }
    const offset = skip > 0 ? members[skip - 1].end : members.pos;
    // shortcut: fqn and version are JSON-quoted; the TypeScript printer escapes the same for ASCII text.
    const info = `{ fqn: ${JSON.stringify(fqn)}, version: ${JSON.stringify(version)} }`;
    if (form === 'field') {
      edits.push({ offset, text: `\n${indent}static [${symbol}] = ${info};` });
      continue;
    }
    temps().request(jsClass);
    annotated.push({ jsClass, offset, indent, info });
  }
  if (edits.length === 0 && annotated.length === 0) {
    return { edits };
  }

  // The temporaries are named once all of them are known (the `var` statement is printed first).
  if (annotated.length > 0) {
    edits.push(...temps().plan());
  }
  const k = file.k;
  for (const { jsClass, offset, indent, info } of annotated) {
    const temp = temps().nameOf(jsClass);
    const first = `${temp} = ${symbol}`;
    if (form === 'staticBlocks') {
      // A static block the emit put first for the class's own temporaries (`static { _a = KEY; }`) is where
      // TypeScript 6 also assigned the rtti temporary.
      const next = jsClass.members.find((m: any) => m.pos >= offset);
      const pending =
        next?.kind === k.ClassStaticBlockDeclaration && next.body.statements.length === 1
          ? temps().pendingAssignments(next.body.statements[0], jsClass)
          : undefined;
      if (pending != null) {
        edits.push(pendingInsertion(pending, first, temps()));
        edits.push({ offset: next.end, text: `\n${indent}static { this[${temp}] = ${info}; }` });
      } else {
        edits.push({
          offset,
          text: `\n${indent}static { ${first}; }\n${indent}static { this[${temp}] = ${info}; }`,
        });
      }
      continue;
    }

    const at = indentationAt(jsText, jsClass.getStart(jsSource));
    const name: string = jsClass.name.text;
    const define =
      form === 'assignments'
        ? `${name}[${temp}] = ${info};`
        : [
            `Object.defineProperty(${name}, ${temp}, {`,
            `${at}    enumerable: true,`,
            `${at}    configurable: true,`,
            `${at}    writable: true,`,
            `${at}    value: ${info}`,
            `${at}});`,
          ].join('\n');
    const after = afterClassStatement(jsClass, jsSource, k);
    // The statement the emit put after the class for its own temporaries (`_a = KEY;`) is where TypeScript 6 also
    // assigned the rtti temporary.
    const statements: any[] = jsClass.parent?.statements ?? [];
    const next = statements.find((st: any) => st.pos >= after);
    const pending = next != null ? temps().pendingAssignments(next, jsClass) : undefined;
    if (pending != null) {
      edits.push(pendingInsertion(pending, first, temps()));
      edits.push({ offset: next.end, text: `\n${at}${define}` });
    } else {
      edits.push({ offset: after, text: `\n${at}${first};\n${at}${define}` });
    }
  }
  return { edits, prepend: `const ${symbol} = Symbol.for("jsii.rtti");` };
}

/**
 * Put `first` (the rtti temporary's assignment) into the emit's own assignment
 * list, after the assignments of private-name storage (`_Foo_x = new WeakMap()`)
 * and before those of other temporaries, which is the order TypeScript 6 used.
 */
// @TODO(NEXT): only reproduces TypeScript 6's statement layout (see Temporaries); after 7.1's first release, assign the
// rtti temporary in a statement of its own.
function pendingInsertion(pending: readonly any[], first: string, temps: Temporaries): Insertion {
  const before = pending.find((assignment) => isCounterName(assignment.left.text) && temps.isTemporary(assignment));
  if (before != null) {
    return { offset: before.left.getStart(), text: `${first}, ` };
  }
  return { offset: pending[pending.length - 1].end, text: `, ${first}` };
}

/**
 * How many members at the start of the emitted class the TypeScript emit added
 * there: a constructor it made up (for field initializers, without
 * `useDefineForClassFields`), the static blocks of ES decorators, then a field
 * per parameter property of the constructor (with `useDefineForClassFields`).
 */
function addedLeadingMembers(tsClass: any, jsMembers: readonly any[], k: any): number {
  const tsMembers: any[] = tsClass.members;
  const isStaticBlock = (m: any) => m?.kind === k.ClassStaticBlockDeclaration;
  let count = 0;
  if (jsMembers[0]?.kind === k.Constructor && !hasConstructor(tsClass, k)) {
    count++;
  }
  if ((tsClass.modifiers ?? []).some((m: any) => m.kind === k.Decorator)) {
    let own = 0;
    while (isStaticBlock(tsMembers[own])) {
      own++;
    }
    let emitted = count;
    while (isStaticBlock(jsMembers[emitted])) {
      emitted++;
    }
    count += Math.max(0, emitted - count - own);
  }
  const ctor = tsMembers.find((m) => m.kind === k.Constructor && m.body != null);
  const parameterProperties: string[] = (ctor?.parameters ?? [])
    .filter((p: any) => (p.modifiers ?? []).some((m: any) => m.kind !== k.Decorator))
    .map((p: any) => p.name?.text);
  for (const name of parameterProperties) {
    const m = jsMembers[count];
    if (m?.kind !== k.PropertyDeclaration || m.initializer != null || m.name?.text !== name) {
      break;
    }
    count++;
  }
  return count;
}

/** Whether the `.ts` class declares a constructor with a body (otherwise an emitted one was made up). */
export function hasConstructor(tsClass: any, k: any): boolean {
  return tsClass.members.some((m: any) => m.kind === k.Constructor && m.body != null);
}

/**
 * Where the statements that follow a class go: after the class statement, and
 * after its `exports.X = X;` when the CommonJS emit put that right after it.
 */
function afterClassStatement(jsClass: any, jsSource: any, k: any): number {
  const statements: any[] = jsClass.parent?.statements ?? [];
  const next = statements[statements.indexOf(jsClass) + 1];
  const name: string = jsClass.name.text;
  const text: string | undefined = next?.kind === k.ExpressionStatement ? next.getText(jsSource) : undefined;
  return text === `exports.${name} = ${name};` || text === `exports.default = ${name};` ? next.end : jsClass.end;
}

/** `_a` … `_z`, `_0`, `_1` …: the names of TypeScript's counter temporaries. */
function isCounterName(name: string): boolean {
  return /^_(?:[a-z]|\d+)$/.test(name);
}

interface Scope {
  readonly node: any;
  readonly parent?: Scope;
  /** The emit's own `var _a, _b;` statement at the top of the scope, if any. */
  readonly declaration?: any;
  /** The names in it. */
  readonly existing: readonly string[];
  /** Where each of them is used (outside its declaration), in source order. */
  readonly uses: Map<string, any[]>;
  /** The classes directly in the scope, in source order. */
  readonly classes: any[];
  /** The classes that get an rtti temporary. */
  readonly requests: any[];
  /** Final names: of the emit's temporaries (by their emitted name), and of the rtti temporaries (by class). */
  readonly renamed: Map<string, string>;
  readonly rtti: Map<any, string>;
  names: string[];
}

/**
 * The temporary names of a file, as TypeScript 6 made them for the rtti and for
 * the emit's own temporaries together: hoisted into one `var` per scope (the
 * file, or a function such as a namespace's), in the order the class transform
 * hoisted them (per class: private-name storage, then the rtti, then the
 * computed keys), and named from a counter per scope (`_a`, `_b`, …, without
 * `_i` and `_n`) when that `var` statement was printed: outer scopes first,
 * skipping the identifiers of the `.ts` file and the names of enclosing scopes.
 * The emit's own counter temporaries are renamed to match.
 */
// @TODO(NEXT): renaming the emit's own temporaries and sharing their `var` and assignment statement only reproduces
// how the TypeScript 6 printer happened to name and order them. After 7.1's first release, give the rtti temporary a
// name of its own (or a `const` next to the class) and leave the emit's temporaries as they are.
class Temporaries {
  private readonly scopes = new Map<any, Scope>();
  private identifiers?: Set<string>;

  public constructor(private readonly file: EmittedFile) {
    this.collect();
  }

  public request(jsClass: any): void {
    this.scopeOf(jsClass).requests.push(jsClass);
  }

  public nameOf(jsClass: any): string {
    return this.scopeOf(jsClass).rtti.get(jsClass)!;
  }

  /** Whether an assignment's left side is one of the emit's temporaries in the scope it is in. */
  public isTemporary(assignment: any): boolean {
    return this.scopeOf(assignment).existing.includes(assignment.left.text);
  }

  /**
   * The assignments of a statement (`_a = x, _b = y;`) when all of them assign
   * the emit's temporaries of the class's scope; otherwise `undefined`.
   */
  public pendingAssignments(statement: any, jsClass: any): any[] | undefined {
    const { k } = this.file;
    if (statement?.kind !== k.ExpressionStatement) {
      return undefined;
    }
    const existing = this.scopeOf(jsClass).existing;
    const assignments: any[] = [];
    const flatten = (expression: any): boolean => {
      if (expression.kind !== k.BinaryExpression) {
        return false;
      }
      if (expression.operatorToken.kind === k.CommaToken) {
        return flatten(expression.left) && flatten(expression.right);
      }
      if (
        expression.operatorToken.kind === k.EqualsToken &&
        expression.left.kind === k.Identifier &&
        existing.includes(expression.left.text)
      ) {
        assignments.push(expression);
        return true;
      }
      return false;
    };
    return flatten(statement.expression) && assignments.length > 0 ? assignments : undefined;
  }

  /** Name everything, and return the edits: the `var` statements and the renamed uses. */
  public plan(): Insertion[] {
    const { jsText, jsSource, k } = this.file;
    const edits: Insertion[] = [];
    const ordered = [...this.scopes.values()].sort((l, r) => (l.node.pos ?? 0) - (r.node.pos ?? 0));
    for (const scope of ordered) {
      // A scope without rtti keeps the emit's names, unless an enclosing scope got rtti (its names come first).
      let affected = scope.requests.length > 0;
      for (let outer = scope.parent; !affected && outer != null; outer = outer.parent) {
        affected = outer.requests.length > 0;
      }
      if (!affected || (scope.requests.length === 0 && scope.existing.length === 0)) {
        continue;
      }
      this.name(scope);
      for (const [old, uses] of scope.uses) {
        const name = scope.renamed.get(old);
        if (name != null && name !== old) {
          edits.push(...uses.map((use) => ({ offset: use.getStart(jsSource), length: old.length, text: name })));
        }
      }
      const declaration = `var ${scope.names.join(', ')};`;
      if (scope.declaration != null) {
        const start = scope.declaration.getStart(jsSource);
        edits.push({ offset: start, length: scope.declaration.end - start, text: declaration });
      } else if (scope.node.kind === k.SourceFile) {
        // After "use strict" and the helpers, before the `__esModule` marker.
        const statements: any[] = scope.node.statements;
        const marker = statements.find((st) =>
          st.getText(jsSource).startsWith('Object.defineProperty(exports, "__esModule"'),
        );
        edits.push(
          marker != null
            ? { offset: marker.getStart(jsSource), text: `${declaration}\n` }
            : { offset: statements[0].end, text: `\n${declaration}` },
        );
      } else {
        const first = scope.node.body.statements[0];
        edits.push({
          offset: skipWhitespace(jsText, first.pos),
          text: `${declaration}\n${indentationAt(jsText, first.getStart(jsSource))}`,
        });
      }
    }
    return edits;
  }

  private name(scope: Scope): void {
    // Hoisting order: per class (by position), private-name storage, then the rtti, then the other temporaries.
    const ownerStart = (offset: number) => {
      const owner = [...scope.classes].reverse().find((c) => c.getStart(this.file.jsSource) <= offset);
      return owner != null ? owner.getStart(this.file.jsSource) : offset;
    };
    const entries: Array<{ anchor: number; rank: number; index: number; old?: string; rtti?: any }> = [];
    for (const [index, old] of scope.existing.entries()) {
      const firstUse = scope.uses.get(old)?.[0];
      const anchor = firstUse != null ? ownerStart(firstUse.getStart(this.file.jsSource)) : Number.MAX_SAFE_INTEGER;
      entries.push({ anchor, rank: isCounterName(old) ? 2 : 0, index, old });
    }
    for (const [index, jsClass] of scope.requests.entries()) {
      entries.push({ anchor: jsClass.getStart(this.file.jsSource), rank: 1, index, rtti: jsClass });
    }
    entries.sort((l, r) => l.anchor - r.anchor || l.rank - r.rank || l.index - r.index);

    const taken = new Set<string>(scope.existing.filter((n) => !isCounterName(n)));
    for (let outer = scope.parent; outer != null; outer = outer.parent) {
      for (const n of outer.names.length > 0 ? outer.names : outer.existing) {
        taken.add(n);
      }
    }
    let count = 0;
    const next = () => {
      while (true) {
        const c = count++;
        if (c === 8 || c === 13) {
          continue;
        }
        const n = c < 26 ? `_${String.fromCharCode(97 + c)}` : `_${c - 26}`;
        if (!taken.has(n) && !this.tsIdentifiers().has(n)) {
          return n;
        }
      }
    };
    scope.names = entries.map((entry) => {
      if (entry.rtti != null) {
        const n = next();
        scope.rtti.set(entry.rtti, n);
        return n;
      }
      const n = isCounterName(entry.old!) ? next() : entry.old!;
      scope.renamed.set(entry.old!, n);
      return n;
    });
  }

  /** Find the scopes, the emit's own temporaries in them, their uses and the classes. */
  private collect(): void {
    const { jsSource, k } = this.file;
    const functions = [k.FunctionExpression, k.FunctionDeclaration, k.ArrowFunction];
    const temporaryDeclaration = (statement: any): any =>
      statement?.kind === k.VariableStatement && /^var _[\w$]+(?:, _[\w$]+)*;$/.test(statement.getText(jsSource))
        ? statement
        : undefined;
    const enter = (node: any, parent?: Scope): Scope => {
      let declaration: any;
      if (node.kind === k.SourceFile) {
        const statements: any[] = node.statements;
        const marker = statements.findIndex((st) =>
          st.getText(jsSource).startsWith('Object.defineProperty(exports, "__esModule"'),
        );
        declaration = statements.slice(0, marker < 0 ? 1 : marker).find(temporaryDeclaration);
      } else {
        declaration = temporaryDeclaration(node.body?.statements?.[0]);
      }
      const existing: string[] = declaration?.declarationList.declarations.map((d: any) => d.name.text) ?? [];
      const scope: Scope = {
        node,
        parent,
        declaration,
        existing,
        uses: new Map(),
        classes: [],
        requests: [],
        renamed: new Map(),
        rtti: new Map(),
        names: [],
      };
      this.scopes.set(node, scope);
      return scope;
    };
    const visit = (node: any, scope: Scope): undefined => {
      let inner = scope;
      if (functions.includes(node.kind)) {
        inner = enter(node, scope);
      }
      if (node.kind === k.ClassDeclaration || node.kind === k.ClassExpression) {
        scope.classes.push(node);
      }
      if (node.kind === k.Identifier && node.text.startsWith('_')) {
        for (let s: Scope | undefined = scope; s != null; s = s.parent) {
          if (s.existing.includes(node.text)) {
            const inDeclaration =
              s.declaration != null && node.pos >= s.declaration.pos && node.end <= s.declaration.end;
            if (!inDeclaration) {
              s.uses.set(node.text, [...(s.uses.get(node.text) ?? []), node]);
            }
            break;
          }
        }
      }
      node.forEachChild((child: any) => visit(child, inner));
      return undefined;
    };
    const root = enter(jsSource);
    jsSource.forEachChild((child: any) => visit(child, root));
  }

  private scopeOf(node: any): Scope {
    const { k } = this.file;
    const functions = [k.FunctionExpression, k.FunctionDeclaration, k.ArrowFunction];
    for (let current = node.parent; current != null; current = current.parent) {
      if (functions.includes(current.kind) || current.kind === k.SourceFile) {
        return this.scopes.get(current)!;
      }
    }
    return this.scopes.get(this.file.jsSource)!;
  }

  private tsIdentifiers(): Set<string> {
    if (this.identifiers == null) {
      this.identifiers = new Set<string>();
      const visit = (node: any): undefined => {
        if (node.kind === this.file.k.Identifier) {
          this.identifiers!.add(node.text);
        }
        node.forEachChild(visit);
        return undefined;
      };
      this.file.tsSource.forEachChild(visit);
    }
    return this.identifiers;
  }
}

/**
 * `factory.createUniqueName('JSII_RTTI_SYMBOL')`: the first `JSII_RTTI_SYMBOL_<n>`
 * that is not an identifier of the `.ts` file.
 */
function uniqueName(file: EmittedFile): string {
  const text: string = file.tsSource.text;
  let n = 1;
  if (!text.includes(`${RTTI_SYMBOL_NAME}_`)) {
    return `${RTTI_SYMBOL_NAME}_${n}`;
  }
  const identifiers = new Set<string>();
  const visit = (node: any): undefined => {
    if (node.kind === file.k.Identifier) {
      identifiers.add(node.text);
    }
    node.forEachChild(visit);
    return undefined;
  };
  file.tsSource.forEachChild(visit);
  while (identifiers.has(`${RTTI_SYMBOL_NAME}_${n}`)) {
    n++;
  }
  return `${RTTI_SYMBOL_NAME}_${n}`;
}
