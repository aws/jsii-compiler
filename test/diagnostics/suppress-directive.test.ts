import { compileJsiiForDiagnostics } from '../compiler-helpers';

describe('@jsii suppress', () => {
  test('ignores an unknown identifier and does not suppress anything', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export class Foo {
        /** @jsii suppress not-a-diagnostic */
        public foo(): void { /* noop */ }
      }
    `);

    // JSII5019 is only a warning, and is still reported
    expect(diagnostics.some((d) => d.jsiiCode === 5019)).toBe(true);
  });
});
