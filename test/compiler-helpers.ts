import { Diagnostic, DiagnosticCategory } from 'typescript';
import { CompilerOptions } from '../src/compiler';
import { compileJsiiForTest, TestCompilationOptions } from '../src/helpers';

export function compileJsiiForErrors<O extends Omit<TestCompilationOptions, 'captureDiagnostics'>>(
  source: string | { 'index.ts': string; [name: string]: string },
  options?: O,
  compilerOptions?: Omit<CompilerOptions, 'projectInfo' | 'watch'>,
): string[] {
  const r = compileJsiiForTest(source, { ...options, captureDiagnostics: true }, compilerOptions);
  return errors(r.diagnostics);
}

export function errors(xs: readonly Diagnostic[]) {
  return xs.filter((x) => x.category === DiagnosticCategory.Error).map((x) => `${x.messageText}`);
}
