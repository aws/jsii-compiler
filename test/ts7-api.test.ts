import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';

import { toTsDiagnostic } from '../src/ts7';
import { resolveTypeScript7PackageDir, TS7_INSTALL_HINT, TS7_TYPESCRIPT_ENV } from '../src/ts7/ts7-api';
import { _formatDiagnostic } from '../src/utils';

// Toolchain-free tests for the TypeScript 7 API loader and diagnostics mapping.

function fakePackage(version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsii-ts7-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'typescript', version }));
  return dir;
}

describe('resolveTypeScript7PackageDir', () => {
  test('honours JSII_TS7_TYPESCRIPT when the package is new enough', () => {
    const dir = fakePackage('7.1.0-beta');
    expect(resolveTypeScript7PackageDir('/nonexistent', { [TS7_TYPESCRIPT_ENV]: dir })).toBe(dir);
  });

  test('rejects JSII_TS7_TYPESCRIPT pointing at a too-old package', () => {
    const dir = fakePackage('6.0.2');
    expect(() => resolveTypeScript7PackageDir('/nonexistent', { [TS7_TYPESCRIPT_ENV]: dir })).toThrow(/>= 7\.1/);
  });

  test('falls back to the typescript7 alias installed with this compiler', () => {
    const dir = resolveTypeScript7PackageDir('/nonexistent', {});
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('typescript');
    expect(pkg.version).toMatch(/^7\./);
  });

  test('install hint is a single npm command', () => {
    expect(TS7_INSTALL_HINT).toBe('npm i -D typescript7@npm:typescript@beta');
  });
});

describe('toTsDiagnostic', () => {
  const source = 'export const x: number = "a";\n';
  const readSource = (fileName: string) => ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false);

  test('maps the TS7 wire shape to a ts.Diagnostic with a real source range', () => {
    const d = toTsDiagnostic(
      { fileName: '/p/src/bad.ts', pos: 13, end: 14, code: 2322, category: 1, text: 'Type mismatch.' },
      readSource,
    );
    expect(d.category).toBe(ts.DiagnosticCategory.Error);
    expect(d.code).toBe(2322);
    expect(d.file?.fileName).toBe('/p/src/bad.ts');
    expect(d.start).toBe(13);
    expect(d.length).toBe(1);
    expect(d.messageText).toBe('Type mismatch.');
  });

  test('renders through the classic formatter with file(line,col) and source context', () => {
    const d = toTsDiagnostic(
      { fileName: '/p/src/bad.ts', pos: 13, end: 14, code: 2322, category: 1, text: 'Type mismatch.' },
      readSource,
    );
    const rendered = _formatDiagnostic(d, '/p').replace(/\u001b\[[0-9;]*m/g, '');
    expect(rendered).toContain('src/bad.ts:1:14 - error TS2322: Type mismatch.');
    expect(rendered).toContain('export const x: number = "a";');
  });

  test('tolerates diagnostics without a file', () => {
    const d = toTsDiagnostic({ code: 5023, category: 1, text: 'Unknown compiler option.' }, readSource);
    expect(d.file).toBeUndefined();
    expect(d.start).toBeUndefined();
    expect(d.messageText).toBe('Unknown compiler option.');
  });
});
