import { compileJsiiForTest, JsiiDiagnostic } from '../../../src';
import { silencedWarnings } from '../../../src/warnings';

afterEach(() => {
  silencedWarnings.clear();
});

describe('@jsii suppress', () => {
  test('ignores an unknown identifier and does not suppress anything', () => {
    silencedWarnings.add(3);
    const result = compileJsiiForTest(
      `
      export class Foo {
        /** @jsii suppress not-a-diagnostic */
        public foo(): void { /* noop */ }
      }
    `,
      { captureDiagnostics: true },
      { failOnWarnings: true },
    );
    expect(result.type).toBe('failure');
    expect(result.diagnostics.some((d) => JsiiDiagnostic.isJsiiDiagnostic(d) && d.jsiiCode === 5019)).toBe(true);
  });
});
