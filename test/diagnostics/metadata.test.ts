import { compileJsiiForDiagnostics } from '../compiler-helpers';

describe('JSII0007 metadata/missing-warnings-export', () => {
  const source = 'export class Klass {}';

  test('is reported when deprecation warnings are added and "exports" lacks the warnings file', () => {
    const diagnostics = compileJsiiForDiagnostics(
      source,
      { packageJson: { exports: { '.': './index.js' } } },
      { addDeprecationWarnings: true },
    );

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 7,
        messageText: expect.stringContaining('"./.warnings.jsii.js": "./.warnings.jsii.js"'),
      }),
    );
  });

  test('is not reported when "exports" contains the warnings file', () => {
    const diagnostics = compileJsiiForDiagnostics(
      source,
      { packageJson: { exports: { '.': './index.js', './.warnings.jsii.js': './.warnings.jsii.js' } } },
      { addDeprecationWarnings: true },
    );

    expect(diagnostics.map((d) => d.jsiiCode)).not.toContain(7);
  });

  test('is not reported when deprecation warnings are not added', () => {
    const diagnostics = compileJsiiForDiagnostics(source, { packageJson: { exports: { '.': './index.js' } } });

    expect(diagnostics.map((d) => d.jsiiCode)).not.toContain(7);
  });
});
