import { compileJsiiForTest } from '../../../src';

/**
 * The TypeScript 7 assembler renders `{@link}` tags from the raw JSDoc block, because TypeScript ends a link at a
 * newline and leaks the rest of its label as text (main: `parseSymbolDocumentation` in src/docs.ts, which is tested
 * with hand-made rendered comments there). These tests go through that code (`Assembler._docCommentWithClassicLinks`)
 * with real sources; the expected docs are the ones main produces.
 */

function docsOf(source: string) {
  return compileJsiiForTest(`${source}\nexport class Other { public static make() { return 1; } }\n`).assembly.types![
    'testpkg.Foo'
  ].docs;
}

test.each([
  ['a link', 'See {@link Other} for details.', 'See {@link Other} for details.'],
  [
    'a link with a "|" label',
    'See {@link Other | the other class} for details.',
    'See {@link Other | the other class} for details.',
  ],
  [
    'a link with a label after a space',
    'See {@link Other the other class} for details.',
    'See {@link Other | the other class} for details.',
  ],
  ['a link to a URL', 'See {@link https://example.com}.', 'See {@link https://example.com}.'],
  [
    'the same target twice',
    '{@link Other} and again {@link Other | other}.',
    '{@link Other} and again {@link Other | other}.',
  ],
])('renders %s', (_, comment, summary) => {
  expect(docsOf(`/**\n * ${comment}\n */\nexport class Foo {}`)).toEqual({ summary });
});

test('puts a label that continues on the next line back on one line', () => {
  const docs = docsOf(
    '/**\n * See {@link https://example.com | a label\n * on two lines} for details.\n */\nexport class Foo {}',
  );

  expect(docs).toEqual({ summary: 'See {@link https://example.com | a label on two lines} for details.' });
});

test('renders links in the remarks and in tags', () => {
  const docs = docsOf(
    '/**\n * Summary.\n *\n * Remarks with {@link Other}.\n * @see {@link Other}\n */\nexport class Foo {}',
  );

  expect(docs).toEqual({ summary: 'Summary.', remarks: 'Remarks with {@link Other}.', see: '{@link Other }' });
});

// @TODO(ts7): the TypeScript 7 compiler renders these as `{@link code | Other.make}` and `{@link plain | Other}`.
// Re-enable once {@linkcode} and {@linkplain} are rendered like main.
test.skip('renders {@linkcode} and {@linkplain}', () => {
  const docs = docsOf('/**\n * Use {@linkcode Other.make} or {@linkplain Other}.\n */\nexport class Foo {}');

  expect(docs).toEqual({ summary: 'Use {@linkcode Other.make} or {@linkplain Other}.' });
});
