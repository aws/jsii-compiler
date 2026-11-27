import { Code, compileJsiiForTest } from '../../src';
import { compileJsiiForDiagnostics } from '../compiler-helpers';

describe('JSII2100 jsii-directive/struct-on-non-interface', () => {
  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2942
  // The diagnostic is registered but nothing emits it: `@struct` on a class is reported as JSII7001 instead.
  // @TODO(ts7): expects a jsii validation diagnostic (JSII7001 for @struct on a class); re-enable with the port of the validator
  test.skip('is registered, but is not emitted for "@struct" on a class (JSII7001 is)', () => {
    expect(Code.lookup('jsii-directive/struct-on-non-interface')).toBe(Code.lookup(2100));

    const codes = compileJsiiForDiagnostics(`
      /** @struct */
      export class Klass {}
    `).map((d) => d.jsiiCode);

    expect(codes).toContain(7001);
    expect(codes).not.toContain(2100);
  });
});

describe('@jsii with inline {@link} tags in the comment', () => {
  function compileWithDirective(directive: string) {
    const diagnostics = compileJsiiForDiagnostics(`
      ${directive}
      export class Klass {}
    `);
    return diagnostics.filter((d) => d.jsiiCode === 2999).map((d) => `${d.messageText}`);
  }

  test('the text parts are still interpreted as directives', () => {
    // The class is ignored, the link itself is not a valid directive
    const result = compileJsiiForTest('/** @jsii ignore {@link Foo} */ export class Klass {}');
    expect(result.assembly.types ?? {}).toEqual({});
    expect(compileWithDirective('/** @jsii ignore {@link Foo} */')).toEqual([
      expect.stringContaining('Unknown @jsii directive: "Foo:"'),
    ]);
  });

  test('a link with a name is reported as an unknown directive, including the link text', () => {
    expect(compileWithDirective('/** @jsii {@link Foo some text} */')).toEqual([
      expect.stringContaining('Unknown @jsii directive: "Foo: some text"'),
    ]);
  });

  test.each(['{@linkcode Foo some text}', '{@linkplain Foo some text}'])('%s is handled like {@link}', (link) => {
    expect(compileWithDirective(`/** @jsii ${link} */`)).toEqual([
      expect.stringContaining('Unknown @jsii directive: "Foo: some text"'),
    ]);
  });

  test('an empty link and blank text are ignored', () => {
    expect(compileWithDirective('/** @jsii {@link } ignore */')).toEqual([]);
  });
});
