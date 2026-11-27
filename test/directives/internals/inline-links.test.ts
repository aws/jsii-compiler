import * as ts from 'typescript';

import { Directives } from '../../../src/directives';

describe('@jsii with inline {@link} tags in the comment', () => {
  function directivesOf(source: string) {
    const sourceFile = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const messages = new Array<string>();
    const directives = Directives.of(sourceFile.statements[0], (diag) => {
      messages.push(`${diag.messageText}`);
    });
    return { directives, messages };
  }

  test('the text parts are still interpreted as directives', () => {
    const { directives, messages } = directivesOf(`/** @jsii ignore {@link Foo} */ export class Klass {}`);

    expect(directives.ignore).toBeTruthy();
    // The link itself is not a valid directive
    expect(messages).toEqual([expect.stringContaining('Unknown @jsii directive: "Foo:"')]);
  });

  test('a link with a name is reported as an unknown directive, including the link text', () => {
    const { directives, messages } = directivesOf(`/** @jsii {@link Foo some text} */ export class Klass {}`);

    expect(directives.ignore).toBeFalsy();
    expect(messages).toEqual([expect.stringContaining('Unknown @jsii directive: "Foo: some text"')]);
  });

  test.each(['{@linkcode Foo some text}', '{@linkplain Foo some text}'])('%s is handled like {@link}', (link) => {
    const { messages } = directivesOf(`/** @jsii ${link} */ export class Klass {}`);

    expect(messages).toEqual([expect.stringContaining('Unknown @jsii directive: "Foo: some text"')]);
  });

  test('suppress directives are still recognized next to a link', () => {
    const { directives } = directivesOf(`/** @jsii suppress JSII1234 {@link Foo} */ export class Klass {}`);

    expect(directives.suppressions).toEqual(['JSII1234']);
  });

  test('an empty link and blank text are ignored', () => {
    const { directives, messages } = directivesOf(`/** @jsii {@link } ignore */ export class Klass {}`);

    expect(directives.ignore).toBeTruthy();
    expect(messages).toEqual([]);
  });
});
