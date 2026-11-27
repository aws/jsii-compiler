/*
 * ---------------------------------------------------------------------------
 * Code jsii adds to the emitted `.js` after emit (TypeScript 7 has no
 * transformer hook): pairing the classes of a `.ts` file with the classes
 * emitted for it, and placing new code where the TypeScript 6 printer put the
 * nodes a transformer added, so the output stays the same as before.
 * ---------------------------------------------------------------------------
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import * as path from 'node:path';

import { Insertion } from './source-map';

/** An emitted `.js` file, parsed, with the `.ts` file it was emitted from. */
export interface EmittedFile {
  readonly jsFile: string;
  readonly jsText: string;
  readonly jsSource: any;
  readonly tsFile: string;
  readonly tsSource: any;
  /** `SyntaxKind` of the TypeScript 7 API. */
  readonly k: any;
  /** The classes of the `.ts` file with the class emitted for each, in source order. */
  readonly classes: ReadonlyArray<{ readonly ts: any; readonly js: any; readonly qualifiedName?: string }>;
}

/**
 * Pair each class of the `.ts` file with the class emitted for it: both files
 * hold the same classes in the same order (only ambient classes are not
 * emitted), which is checked by name. Returns `undefined` when they differ.
 */
export function pairClasses(tsSource: any, jsSource: any, k: any): EmittedFile['classes'] | undefined {
  const tsClasses = classDeclarations(tsSource, k, true);
  const jsClasses = classDeclarations(jsSource, k, false);
  if (
    tsClasses.length !== jsClasses.length ||
    tsClasses.some((c, i) => className(c.node, k) !== className(jsClasses[i].node, k))
  ) {
    // shortcut: classes are paired by order and name. A transform that adds or reorders
    // classes (e.g. ES decorators) breaks that; map through the source map if that ever matters.
    return undefined;
  }
  return tsClasses.map((c, i) => ({ ts: c.node, js: jsClasses[i].node, qualifiedName: c.qualifiedName }));
}

/**
 * The name of a class, or of the variable a class expression is assigned to
 * (the emit turns an ES-decorated `class X` into `var X = class { ... }`).
 */
function className(node: any, k: any): string | undefined {
  if (node.name != null) {
    return node.name.text;
  }
  return node.kind === k.ClassExpression && node.parent?.kind === k.VariableDeclaration
    ? node.parent.name?.text
    : undefined;
}

/**
 * The classes of a source file, in source order, without ambient ones (which
 * are not emitted). With `qualify`, a class directly inside a file or
 * namespace gets its in-file name (`Namespace.Class`).
 */
function classDeclarations(sourceFile: any, k: any, qualify: boolean): Array<{ node: any; qualifiedName?: string }> {
  const result: Array<{ node: any; qualifiedName?: string }> = [];
  const isAmbient = (node: any) => (node.modifiers ?? []).some((m: any) => m.kind === k.DeclareKeyword);
  const visit = (node: any, namespace: string[] | undefined): undefined => {
    if (node.kind === k.ClassDeclaration || node.kind === k.ClassExpression) {
      if (!isAmbient(node)) {
        const name = node.name?.text;
        result.push({
          node,
          qualifiedName: qualify && namespace != null && name != null ? [...namespace, name].join('.') : undefined,
        });
        node.forEachChild((child: any) => visit(child, undefined));
      }
      return undefined;
    }
    if (node.kind === k.ModuleDeclaration) {
      if (!isAmbient(node) && node.body != null) {
        visit(node.body, namespace && [...namespace, node.name.text]);
      }
      return undefined;
    }
    node.forEachChild((child: any) => visit(child, node.kind === k.ModuleBlock ? namespace : undefined));
    return undefined;
  };
  sourceFile.forEachChild((child: any) => visit(child, []));
  return result;
}

/**
 * Where the printed statement goes in the body of an emitted member: before
 * the statement at `index`, laid out like the TypeScript printer lays out a
 * block, on one line (`{ a; b; }`) or one statement per line. (The comments
 * the TypeScript 6 printer lost in that body are removed by `rewrittenBodyEdits`.)
 */
export function statementInsertion(
  jsText: string,
  jsSource: any,
  member: any,
  index: number,
  printed: string,
): Insertion[] {
  const body = member.body;
  const statements: any[] = body.statements;
  const open = body.getStart(jsSource);
  const memberIndent = indentationAt(jsText, member.getStart(jsSource));
  const afterPrevious = index === 0 ? open + 1 : statements[index - 1].end;
  const multiLine = jsText.slice(open, body.end).includes('\n');

  const edits: Insertion[] = [];

  if (!multiLine) {
    edits.push({ offset: afterPrevious, text: ` ${indentLines(printed, memberIndent)}` });
    return edits;
  }
  const indent = `${memberIndent}    `;
  if (index < statements.length) {
    edits.push({
      offset: skipWhitespace(jsText, statements[index].pos),
      text: `${indentLines(printed, indent)}\n${indent}`,
    });
  } else {
    edits.push({ offset: afterPrevious, text: `\n${indent}${indentLines(printed, indent)}` });
  }
  return edits;
}

/**
 * With --add-deprecation-warnings, the classic transformer replaced the body of
 * every method, accessor and constructor it reached (in any class or object
 * literal, whether or not it added a call), and did not look inside them. The
 * TypeScript 6 printer then lost the comments before the closing `}` of each
 * such body (aws/jsii-compiler#3001). The edits that remove the same comments.
 */
export function rewrittenBodyEdits(jsText: string, jsSource: any, k: any): Insertion[] {
  const edits: Insertion[] = [];
  const kinds = [k.MethodDeclaration, k.GetAccessor, k.SetAccessor, k.Constructor];
  const visit = (node: any): undefined => {
    if (kinds.includes(node.kind) && node.body != null) {
      const body = node.body;
      const open = body.getStart(jsSource);
      const multiLine = jsText.slice(open, body.end).includes('\n');
      const replacement = multiLine ? `\n${indentationAt(jsText, node.getStart(jsSource))}` : ' ';
      edits.push(...dropCommentsBeforeClose(jsText, body.statements, open + 1, body.end - 1, replacement));
      return undefined;
    }
    node.forEachChild(visit);
    return undefined;
  };
  jsSource.forEachChild(visit);
  return edits;
}

/**
 * The edit that removes the comments between the last element of a list the
 * TypeScript 6 printer rewrote (block statements, class members) and the
 * closing `}`: they belong to the `}` token, whose position is lost with the
 * new list. A comment on the line of the last element is its trailing comment
 * and is kept.
 */
export function dropCommentsBeforeClose(
  jsText: string,
  elements: readonly any[],
  listStart: number,
  close: number,
  replacement: string,
): Insertion[] {
  const last = elements[elements.length - 1];
  let tailStart = listStart;
  if (last != null) {
    const lineEnd = jsText.indexOf('\n', last.end);
    tailStart = lineEnd >= 0 && lineEnd < close ? lineEnd : close;
  }
  if (jsText.slice(tailStart, close).trim() === '') {
    return [];
  }
  return [{ offset: tailStart, length: close - tailStart, text: replacement }];
}

/**
 * The edits that add `added` statements at the top of an emitted file, laid
 * out like the TypeScript 6 printer did when a transformer made them the first
 * statements of the file:
 *
 * - they come after the CommonJS preamble ("use strict", helpers, the
 *   `__esModule` marker, `exports.x = void 0` and hoisted `exports.f = f`);
 * - the prologue directives of the `.ts` file are no longer a prologue, so they
 *   move after them (and a "use strict" is added back at the top);
 * - comments that the emit put between preamble lines (detached comments at the
 *   top of the file) move after them too, and comments at the end of the file are
 *   dropped (their positions are lost with the new statement list).
 */
export function prependStatements(
  jsText: string,
  jsSource: any,
  tsSource: any,
  k: any,
  added: readonly string[],
): Insertion[] {
  const statements: any[] = jsSource.statements;
  const isDirective = (s: any) => s?.kind === k.ExpressionStatement && s.expression.kind === k.StringLiteral;
  const tsDirectives: string[] = [];
  for (const s of tsSource.statements) {
    if (!isDirective(s)) {
      break;
    }
    tsDirectives.push(s.getText(tsSource));
  }
  const isPreamble = (s: any) => {
    const text: string = s.getText(jsSource);
    return (
      text === '"use strict";' ||
      /^var __\w+ = \(this && this\.__\w+\)/.test(text) ||
      text.startsWith('Object.defineProperty(exports, "__esModule"') ||
      /^exports\.[\w$]+ = (exports\.[\w$]+ = )*void 0;$/.test(text) ||
      /^exports\.[\w$]+ = [A-Za-z_$][\w$]*;$/.test(text)
    );
  };

  const edits: Insertion[] = [];
  const moved: string[] = [];
  // The comments before the first `.ts` statement were its leading comments; they are lost with it when that
  // statement emits no code (a type, for example).
  const keepComments = tsDirectives.length > 0 || emitsCode(tsSource.statements[0], jsText, k);
  const move = (from: number, to: number) => {
    if (from < to) {
      if (keepComments) {
        moved.push(jsText.slice(from, to).trim());
      }
      edits.push({ offset: from, length: to - from, text: '' });
    }
  };
  // Comments before the first statement (after a shebang).
  const fileStart = jsText.startsWith('#!') ? jsText.indexOf('\n') + 1 : 0;
  move(skipWhitespace(jsText, fileStart), statements[0].getStart(jsSource));

  let last = -1;
  let directive = 0;
  let keptUseStrict = false;
  while (last + 1 < statements.length) {
    const s = statements[last + 1];
    const fromSource = isDirective(s) && s.getText(jsSource) === tsDirectives[directive];
    if (!fromSource && !isPreamble(s)) {
      break;
    }
    last++;
    if (last > 0) {
      move(skipWhitespace(jsText, statements[last - 1].end), s.getStart(jsSource));
    }
    if (fromSource) {
      directive++;
      const start = s.getStart(jsSource);
      moved.push(s.getText(jsSource));
      edits.push({ offset: start, length: skipWhitespace(jsText, s.end) - start, text: '' });
    } else {
      keptUseStrict ||= s.getText(jsSource) === '"use strict";';
    }
  }
  // shortcut: a file with nothing but its preamble has no class to inject into, so `last` is never the last statement.
  if (!keptUseStrict) {
    edits.push({ offset: statements[0].getStart(jsSource), text: '"use strict";\n' });
  }

  const at = last >= 0 ? skipWhitespace(jsText, statements[last].end) : statements[0].getStart(jsSource);
  edits.push({ offset: at, text: [...added, ...moved].map((line) => `${line}\n`).join('') });

  const end = statements[statements.length - 1].end;
  const lineEnd = jsText.indexOf('\n', end);
  const mapComment = jsText.lastIndexOf('\n//# sourceMappingURL=');
  const tailEnd = mapComment >= lineEnd ? mapComment : jsText.length;
  if (lineEnd >= 0 && jsText.slice(lineEnd, tailEnd).trim() !== '') {
    edits.push({ offset: lineEnd, length: tailEnd - lineEnd, text: mapComment >= lineEnd ? '' : '\n' });
  }
  return edits;
}

/**
 * Whether a top-level `.ts` statement emits code (as opposed to a type, an
 * ambient declaration or an import that is only used for types).
 */
function emitsCode(statement: any, jsText: string, k: any): boolean {
  if (statement == null) {
    return false;
  }
  const modifiers: any[] = statement.modifiers ?? [];
  switch (statement.kind) {
    case k.InterfaceDeclaration:
    case k.TypeAliasDeclaration:
      return false;
    case k.EnumDeclaration:
      return !modifiers.some((m) => m.kind === k.ConstKeyword || m.kind === k.DeclareKeyword);
    case k.ModuleDeclaration:
      return (
        !modifiers.some((m) => m.kind === k.DeclareKeyword) &&
        (statement.body?.kind === k.ModuleDeclaration
          ? emitsCode(statement.body, jsText, k)
          : (statement.body?.statements ?? []).some((s: any) => emitsCode(s, jsText, k)))
      );
    case k.ImportDeclaration: {
      if (statement.importClause == null) {
        return true;
      }
      // shortcut: an import is kept when the emitted file binds its module (`const x_1 = require("x")`).
      const specifier = JSON.stringify(statement.moduleSpecifier.text);
      return (
        !statement.importClause.isTypeOnly &&
        [`= require(${specifier})`, `(require(${specifier}))`].some((form) => jsText.includes(form))
      );
    }
    case k.ExportDeclaration:
      return !statement.isTypeOnly;
    default:
      return !modifiers.some((m) => m.kind === k.DeclareKeyword);
  }
}

export function indentationAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

export function indentLines(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 || line === '' ? line : `${indent}${line}`))
    .join('\n');
}

export function skipWhitespace(text: string, offset: number): number {
  while (offset < text.length && /\s/.test(text[offset])) {
    offset++;
  }
  return offset;
}

export function normalizeRel(p: string): string {
  return p.split(path.sep).join('/');
}
