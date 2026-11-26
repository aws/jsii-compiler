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

const HALF_INDENT = '  ';
const INDENT = '    ';
const ELLIPSIS = '...';

/** Reads the text of a diagnostic's file: attached to it, or else from disk. */
function sourceTextOf(file: DiagnosticSourceFile | undefined, start: number | undefined): string | undefined {
  if (file?.text != null || file?.fileName == null || start == null) {
    return file?.text;
  }
  try {
    return fs.readFileSync(file.fileName, 'utf8');
  } catch {
    return undefined;
  }
}

/** `file:line:col`, relative to the project root. */
function formatLocation(file: DiagnosticSourceFile, text: string | undefined, start: number | undefined, root: string) {
  let out = chalk.cyan(path.relative(root, file.fileName) || file.fileName);
  if (text != null && start != null) {
    const { line, character } = getLineAndCharacterOfPosition(text, start);
    out += `:${chalk.yellow(line + 1)}:${chalk.yellow(character + 1)}`;
  }
  return out;
}

/**
 * The source lines a range covers, each with a squiggle line under it, like
 * the classic `ts.formatDiagnosticsWithColorAndContext` (leading newline per
 * line, none at the end; trailing whitespace trimmed, tabs as spaces, more than
 * 5 lines elided).
 */
function formatCodeSpan(
  text: string,
  start: number,
  length: number,
  indent: string,
  color: (s: string) => string,
): string {
  const first = getLineAndCharacterOfPosition(text, start);
  const last = getLineAndCharacterOfPosition(text, start + length);
  const lines = text.split('\n');
  const hasMoreThanFiveLines = last.line - first.line >= 4;
  let gutterWidth = String(last.line + 1).length;
  if (hasMoreThanFiveLines) {
    gutterWidth = Math.max(ELLIPSIS.length, gutterWidth);
  }
  const gutter = (label: string) => `${indent}${chalk.black.bgWhite(label.padStart(gutterWidth))} `;

  let out = '';
  for (let i = first.line; i <= last.line; i++) {
    out += '\n';
    if (hasMoreThanFiveLines && first.line + 1 < i && i < last.line - 1) {
      out += `${gutter(ELLIPSIS)}\n`;
      i = last.line - 1;
    }
    const lineContent = (lines[i] ?? '').trimEnd().replace(/\t/g, ' ');
    out += `${gutter(String(i + 1))}${lineContent}\n${gutter('')}`;
    if (i === first.line) {
      const end = i === last.line ? last.character : undefined;
      out += lineContent.slice(0, first.character).replace(/\S/g, ' ');
      out += color(lineContent.slice(first.character, end).replace(/./g, '~'));
    } else if (i === last.line) {
      out += color(lineContent.slice(0, last.character).replace(/./g, '~'));
    } else {
      out += color(lineContent.replace(/./g, '~'));
    }
  }
  return out;
}

/**
 * Renders a diagnostic the way the classic `formatDiagnosticsWithColorAndContext`
 * does: a `file:line:col - category TSxxxx: message` header followed, when the
 * source is available, by the offending lines and a squiggle under the reported
 * range, and then the related information, if the diagnostic has any.
 */
export function formatDiagnosticWithColorAndContext(diagnostic: Diagnostic, projectRoot: string): string {
  const color = categoryColor(diagnostic.category);
  let out = '';
  const text = sourceTextOf(diagnostic.file, diagnostic.start);
  if (diagnostic.file) {
    out += `${formatLocation(diagnostic.file, text, diagnostic.start, projectRoot)} - `;
  }
  out += `${color(categoryName(diagnostic.category))}${chalk.grey(` TS${diagnostic.code}: `)}${
    diagnostic.messageText
  }\n`;

  if (diagnostic.file && text != null && diagnostic.start != null) {
    out += `${formatCodeSpan(text, diagnostic.start, diagnostic.length ?? 1, '', color)}\n`;
  }

  // The classic formatter checks for the presence of the array, not for entries
  // in it, so a diagnostic that has one (jsii's always do) gets an extra newline.
  const related = (diagnostic as { relatedInformation?: readonly Diagnostic[] }).relatedInformation;
  if (related) {
    for (const info of related) {
      const infoText = sourceTextOf(info.file, info.start);
      if (info.file) {
        out += `\n${HALF_INDENT}${formatLocation(info.file, infoText, info.start, projectRoot)}`;
        if (infoText != null && info.start != null) {
          out += formatCodeSpan(infoText, info.start, info.length ?? 1, INDENT, chalk.cyan);
        }
      }
      out += `\n${INDENT}${info.messageText}`;
    }
    out += '\n';
  }
  return out;
}
