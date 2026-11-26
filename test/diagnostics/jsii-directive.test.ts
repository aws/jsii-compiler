import { Code } from '../../src/jsii-diagnostic';
import { compileJsiiForDiagnostics } from '../compiler-helpers';

describe('JSII2100 jsii-directive/struct-on-non-interface', () => {
  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2942
  // The diagnostic is registered but nothing emits it: `@struct` on a class is reported as JSII7001 instead.
  test('is registered, but is not emitted for "@struct" on a class (JSII7001 is)', () => {
    expect(Code.lookup('jsii-directive/struct-on-non-interface')).toBe(Code.lookup(2100));

    const codes = compileJsiiForDiagnostics(`
      /** @struct */
      export class Klass {}
    `).map((d) => d.jsiiCode);

    expect(codes).toContain(7001);
    expect(codes).not.toContain(2100);
  });
});
