import { flattenDiagnosticMessageText } from 'typescript';
import { Diagnostic } from '../../src/diagnostic';
import { compileJsiiForTest, TestCompilationOptions } from '../../src/helpers';
import { JsiiDiagnostic } from '../../src/jsii-diagnostic';

/**
 * Compiles the given source and returns its diagnostics (of any category), as "<code>: <message>" strings.
 *
 * The warnings about missing package metadata (JSII0001 to JSII0003) that every test package gets are left out.
 */
export function compileForDiagnostics(
  source: string | { 'index.ts': string; [name: string]: string },
  options?: Omit<TestCompilationOptions, 'captureDiagnostics'>,
): string[] {
  const result = compileJsiiForTest(source, { ...options, captureDiagnostics: true });
  return result.diagnostics.filter((d) => !JsiiDiagnostic.isJsiiDiagnostic(d) || d.jsiiCode > 3).map(format);
}

function format(diagnostic: Diagnostic): string {
  const code = JsiiDiagnostic.isJsiiDiagnostic(diagnostic) ? `JSII${diagnostic.jsiiCode}` : `TS${diagnostic.code}`;
  return `${code}: ${flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
}
