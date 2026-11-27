import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';

import { parseSymbolDocumentation } from '../../../src/docs';

/**
 * TypeScript terminates a `{@link}` at the first newline, and leaks the rest of the label as text.
 * `parseSymbolDocumentation` repairs this by cross-checking the JSDoc AST against the rendered comment. These tests
 * feed it rendered comments that do not line up with the AST, which cannot be produced from source code alone.
 */

const SOURCE = `
/**
 * See {@link https://example.com | a label
 * on two lines} for details.
 */
export class Foo {}
`;

let workdir: string;
let program: ts.Program;
let symbol: ts.Symbol;

beforeAll(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsii-docs-guards-'));
  const file = path.join(workdir, 'index.ts');
  fs.writeFileSync(file, SOURCE);
  program = ts.createProgram([file], { noLib: true });
  const checker = program.getTypeChecker();
  const classDecl = program.getSourceFile(file)!.statements.find(ts.isClassDeclaration)!;
  symbol = checker.getSymbolAtLocation(classDecl.name!)!;
});

afterAll(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

/**
 * Wraps the real symbol so that its documentation comment is rendered as `text`, while its declarations (and their
 * JSDoc AST) remain those of the real source.
 */
function withRenderedComment(text: string): ts.Symbol {
  const parts: ts.SymbolDisplayPart[] = [{ kind: 'text', text }];
  return Object.create(symbol, {
    getDocumentationComment: { value: () => parts },
  });
}

test('repairs a truncated link when the rendered comment matches the source', () => {
  const rendered = 'See {@link https://example.com | a label} * on two lines} for details.';
  const result = parseSymbolDocumentation(withRenderedComment(rendered), program.getTypeChecker());

  expect(result.docs.summary).toBe('See {@link https://example.com | a label on two lines} for details.');
});

test('leaves the comment unchanged when the leaked label text is absent from the rendered comment', () => {
  const rendered = 'See {@link https://example.com | a label} but TypeScript rendered the tail differently.';
  const result = parseSymbolDocumentation(withRenderedComment(rendered), program.getTypeChecker());

  expect(result.docs.summary).toBe(rendered);
});

test('leaves the comment unchanged when the leaked label text is not preceded by a link tag', () => {
  // The leaked tail is found, but no `{@` precedes it, so there is no link to rewrite.
  const rendered = 'a label} * on two lines} then {@link later.';
  const result = parseSymbolDocumentation(withRenderedComment(rendered), program.getTypeChecker());

  expect(result.docs.summary).toBe(rendered);
});
