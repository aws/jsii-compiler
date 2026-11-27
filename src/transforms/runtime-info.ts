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
 * emitted text after emit, where the TypeScript 6 printer put it.
 * ---------------------------------------------------------------------------
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { dropCommentsBeforeClose, EmittedFile, indentationAt } from './emitted-js';
import { Insertion } from './source-map';

// @TODO(NEXT): the rtti form (a `static [JSII_RTTI_SYMBOL_1]` member spliced into the emitted text) copies TS6's
// transformer output, and needs text surgery because TS7 has no transformers. After 7.1's first release: settle on
// one form (e.g. the `Object.defineProperty` statements of `rttiSnippet`) and drop the splicing.
const RTTI_SYMBOL_NAME = 'JSII_RTTI_SYMBOL';

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
): { readonly edits: Insertion[]; readonly prepend?: string } {
  const { jsText, jsSource } = file;
  const symbol = uniqueName(file);
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
    // shortcut: fqn and version are JSON-quoted; the TypeScript printer escapes the same for ASCII text.
    edits.push({
      offset: skip > 0 ? members[skip - 1].end : members.pos,
      text: `\n${indent}static [${symbol}] = { fqn: ${JSON.stringify(fqn)}, version: ${JSON.stringify(version)} };`,
    });
  }
  if (edits.length === 0) {
    return { edits };
  }
  return { edits, prepend: `const ${symbol} = Symbol.for("jsii.rtti");` };
}

/**
 * How many members at the start of the emitted class the TypeScript emit added
 * there: the static blocks of ES decorators, then a field per parameter
 * property of the constructor (with `useDefineForClassFields`).
 */
function addedLeadingMembers(tsClass: any, jsMembers: readonly any[], k: any): number {
  const tsMembers: any[] = tsClass.members;
  const isStaticBlock = (m: any) => m?.kind === k.ClassStaticBlockDeclaration;
  let count = 0;
  if ((tsClass.modifiers ?? []).some((m: any) => m.kind === k.Decorator)) {
    let own = 0;
    while (isStaticBlock(tsMembers[own])) {
      own++;
    }
    let emitted = 0;
    while (isStaticBlock(jsMembers[emitted])) {
      emitted++;
    }
    count = Math.max(0, emitted - own);
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
