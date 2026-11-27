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
  const temps = new TemporaryNames(file);
  const edits: Insertion[] = [];
  for (const { ts: tsClass, js: jsClass, qualifiedName } of file.classes) {
    const fqn = qualifiedName != null ? fqnByName.get(qualifiedName) : undefined;
    if (fqn == null || tsClass.kind !== file.k.ClassDeclaration) {
      continue;
    }
    const members: any = jsClass.members;
    const close = jsClass.end - 1;
    const indent = `${indentationAt(jsText, jsClass.getStart(jsSource))}    `;
    // The member list was replaced, so the printer lost the comments before the closing `}`.
    edits.push(...dropCommentsBeforeClose(jsText, members, members.pos, close, `\n${indentationAt(jsText, close)}`));
    // The static was the first member when the TypeScript transforms ran, and they put their own members
    // before it: the static blocks of ES decorators, then the fields of parameter properties.
    const skip = addedLeadingMembers(tsClass, members, file.k);
    const madeUp = members[0]?.kind === file.k.Constructor && !hasConstructor(tsClass, file.k) ? members[0] : undefined;
    if (madeUp?.body != null) {
      // The emit moves the comments before the class's `}` into the constructor it made up; they were lost too.
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
    const temp = temps.next(jsClass);
    if (form === 'staticBlocks') {
      edits.push({
        offset,
        text: `\n${indent}static { ${temp} = ${symbol}; }\n${indent}static { this[${temp}] = ${info}; }`,
      });
    } else {
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
      edits.push({
        offset: afterClassStatement(jsClass, jsSource, file.k),
        text: `\n${at}${temp} = ${symbol};\n${at}${define}`,
      });
    }
  }
  if (edits.length === 0) {
    return { edits };
  }
  edits.push(...temps.declarations());
  return { edits, prepend: `const ${symbol} = Symbol.for("jsii.rtti");` };
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

/**
 * The temporary names TypeScript 6 made (`_a`, `_b`, ...): one counter per
 * scope (the file, or the function a class is in, such as a namespace), in
 * print order, without `_i` and `_n`, skipping the identifiers of the `.ts`
 * file and the names already taken in the enclosing scopes.
 */
class TemporaryNames {
  private readonly scopes = new Map<any, { count: number; names: string[] }>();
  private identifiers?: Set<string>;

  public constructor(private readonly file: EmittedFile) {}

  public next(node: any): string {
    const chain = this.scopeChain(node);
    const taken = new Set(chain.slice(1).flatMap((scope) => this.scopes.get(scope)?.names ?? []));
    const scope = this.scopes.get(chain[0]) ?? { count: 0, names: [] };
    this.scopes.set(chain[0], scope);
    while (true) {
      const count = scope.count++;
      if (count === 8 || count === 13) {
        continue;
      }
      const name = count < 26 ? `_${String.fromCharCode(97 + count)}` : `_${count - 26}`;
      if (!taken.has(name) && !this.tsIdentifiers().has(name)) {
        scope.names.push(name);
        return name;
      }
    }
  }

  /** The `var _a, _b;` statement at the top of each scope that got names. */
  public declarations(): Insertion[] {
    const { jsText, jsSource, k } = this.file;
    const edits: Insertion[] = [];
    for (const [scope, { names }] of this.scopes) {
      if (names.length === 0) {
        continue;
      }
      const declaration = `var ${names.join(', ')};`;
      if (scope.kind === k.SourceFile) {
        // After "use strict" and the helpers, before the `__esModule` marker.
        // shortcut: a scope that already has temporaries of its own gets a second `var` statement.
        const statements: any[] = scope.statements;
        const marker = statements.find((s) =>
          s.getText(jsSource).startsWith('Object.defineProperty(exports, "__esModule"'),
        );
        edits.push(
          marker != null
            ? { offset: marker.getStart(jsSource), text: `${declaration}\n` }
            : { offset: statements[0].end, text: `\n${declaration}` },
        );
      } else {
        const first = scope.body.statements[0];
        edits.push({
          offset: skipWhitespace(jsText, first.pos),
          text: `${declaration}\n${indentationAt(jsText, first.getStart(jsSource))}`,
        });
      }
    }
    return edits;
  }

  /** The scopes a node is in, innermost first: the functions around it, then the file. */
  private scopeChain(node: any): any[] {
    const { k } = this.file;
    const functions = [k.FunctionExpression, k.FunctionDeclaration, k.ArrowFunction];
    const chain: any[] = [];
    for (let current = node.parent; current != null; current = current.parent) {
      if (functions.includes(current.kind) || current.kind === k.SourceFile) {
        chain.push(current);
      }
    }
    return chain;
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
