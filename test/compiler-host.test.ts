import * as fs from 'node:fs';
import * as path from 'node:path';

import { toDiagnostic } from '../src/compiler';
import { resolveTypeScript7PackageDir } from '../src/compiler-host';
import { DiagnosticCategory } from '../src/diagnostic';
import { _formatDiagnostic } from '../src/utils';

// Toolchain-free tests for the TypeScript 7 API loader and diagnostics mapping.

describe('resolveTypeScript7PackageDir', () => {
  test('resolves the TypeScript 7 package installed with this compiler', () => {
    const dir = resolveTypeScript7PackageDir();
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('typescript');
    expect(pkg.version).toMatch(/^7\./);
  });
});

describe('toDiagnostic', () => {
  const source = 'export const x: number = "a";\n';
  const readSource = (_fileName: string) => source;

  test('maps the TypeScript 7 wire shape to a Diagnostic with a real source range', () => {
    const d = toDiagnostic(
      { fileName: '/p/src/bad.ts', pos: 13, end: 14, code: 2322, category: 1, text: 'Type mismatch.' },
      readSource,
    );
    expect(d.category).toBe(DiagnosticCategory.Error);
    expect(d.code).toBe(2322);
    expect(d.file?.fileName).toBe('/p/src/bad.ts');
    expect(d.start).toBe(13);
    expect(d.length).toBe(1);
    expect(d.messageText).toBe('Type mismatch.');
  });

  test('renders through the classic formatter with file(line,col) and source context', () => {
    const d = toDiagnostic(
      { fileName: '/p/src/bad.ts', pos: 13, end: 14, code: 2322, category: 1, text: 'Type mismatch.' },
      readSource,
    );
    const rendered = _formatDiagnostic(d, '/p').replace(/\u001b\[[0-9;]*m/g, '');
    expect(rendered).toContain('src/bad.ts:1:14 - error TS2322: Type mismatch.');
    expect(rendered).toContain('export const x: number = "a";');
  });

  test('tolerates diagnostics without a file', () => {
    const d = toDiagnostic({ code: 5023, category: 1, text: 'Unknown compiler option.' }, readSource);
    expect(d.file).toBeUndefined();
    expect(d.start).toBeUndefined();
    expect(d.messageText).toBe('Unknown compiler option.');
  });
});
