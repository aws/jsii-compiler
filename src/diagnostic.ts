/**
 * The diagnostic model used throughout the compiler.
 *
 * TypeScript 7 no longer exposes the in-process `ts.Diagnostic` type (the
 * `typescript` package's main entry point only carries the version), so jsii
 * carries its own, deliberately minimal, equivalent. Category values match the
 * numeric `ts.DiagnosticCategory` values so that user-facing configuration
 * (`jsii.diagnostics` in `package.json`) keeps its meaning.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';

export enum DiagnosticCategory {
  Warning = 0,
  Error = 1,
  Suggestion = 2,
  Message = 3,
}

/** A source file a diagnostic points into. */
export interface DiagnosticSourceFile {
  readonly fileName: string;
  /** The full text of the file, when available (used to render source context). */
  readonly text?: string;
}

export interface Diagnostic {
  readonly category: DiagnosticCategory;
  readonly code: number;
  readonly messageText: string;
  readonly file?: DiagnosticSourceFile;
  /** Start offset (UTF-16 code units) within `file`. */
  readonly start?: number;
  readonly length?: number;
}

/** Converts an offset into a 0-based line/character pair. */
export function getLineAndCharacterOfPosition(text: string, position: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < position && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: position - lineStart };
}

function categoryName(category: DiagnosticCategory): string {
  switch (category) {
    case DiagnosticCategory.Error:
      return 'error';
    case DiagnosticCategory.Warning:
      return 'warning';
    case DiagnosticCategory.Suggestion:
      return 'suggestion';
    default:
      return 'message';
  }
}

function categoryColor(category: DiagnosticCategory): (s: string) => string {
  switch (category) {
    case DiagnosticCategory.Error:
      return chalk.red;
    case DiagnosticCategory.Warning:
      return chalk.yellow;
    case DiagnosticCategory.Suggestion:
      return chalk.green;
    default:
      return chalk.blue;
  }
}

/**
 * Renders a diagnostic the way the classic compiler's
 * `formatDiagnosticsWithColorAndContext` does: a `file:line:col - category
 * TSxxxx: message` header followed, when the source is available, by the
 * offending line and a squiggle under the reported range.
 */
export function formatDiagnosticWithColorAndContext(diagnostic: Diagnostic, projectRoot: string): string {
  const color = categoryColor(diagnostic.category);
  let out = '';
  let text = diagnostic.file?.text;
  if (text == null && diagnostic.file?.fileName && diagnostic.start != null) {
    try {
      text = fs.readFileSync(diagnostic.file.fileName, 'utf8');
    } catch {
      text = undefined;
    }
  }
  if (diagnostic.file) {
    const relative = path.relative(projectRoot, diagnostic.file.fileName) || diagnostic.file.fileName;
    out += chalk.cyan(relative);
    if (text != null && diagnostic.start != null) {
      const { line, character } = getLineAndCharacterOfPosition(text, diagnostic.start);
      out += `:${chalk.yellow(line + 1)}:${chalk.yellow(character + 1)}`;
    }
    out += ' - ';
  }
  out += `${color(categoryName(diagnostic.category))}${chalk.grey(` TS${diagnostic.code}: `)}${diagnostic.messageText}\n`;

  if (diagnostic.file && text != null && diagnostic.start != null) {
    const start = getLineAndCharacterOfPosition(text, diagnostic.start);
    const end = getLineAndCharacterOfPosition(text, diagnostic.start + Math.max(diagnostic.length ?? 1, 1));
    const lines = text.split(/\r?\n/);
    const gutterWidth = String(end.line + 1).length;
    out += '\n';
    for (let i = start.line; i <= end.line && i < lines.length; i++) {
      const lineText = lines[i];
      out += `${chalk.black.bgWhite(String(i + 1).padStart(gutterWidth))} ${lineText}\n`;
      const from = i === start.line ? start.character : 0;
      const to = i === end.line ? Math.max(end.character, from + 1) : lineText.length;
      out += `${chalk.black.bgWhite(' '.repeat(gutterWidth))} ${' '.repeat(from)}${color('~'.repeat(Math.max(to - from, 1)))}\n`;
    }
  }
  return out;
}
