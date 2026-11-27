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

/**
 * A chain of nested messages, shaped like the classic `ts.DiagnosticMessageChain`.
 */
export interface DiagnosticMessageChain {
  readonly messageText: string;
  readonly category: DiagnosticCategory;
  readonly code: number;
  readonly next?: DiagnosticMessageChain[];
}

/**
 * The properties are shaped like the classic `ts.Diagnostic` (`file`, `start`
 * and `length` are present but may be `undefined`; `messageText` may be a
 * chain), so a `ts.Diagnostic` can be passed wherever a jsii `Diagnostic` is
 * expected.
 */
export interface Diagnostic {
  readonly category: DiagnosticCategory;
  readonly code: number;
  readonly messageText: string | DiagnosticMessageChain;
  readonly file: DiagnosticSourceFile | undefined;
  /** Start offset (UTF-16 code units) within `file`. */
  readonly start: number | undefined;
  readonly length: number | undefined;
}

/**
 * Renders a message chain as text, the way the classic
 * `ts.flattenDiagnosticMessageText` does: each nested message on its own line,
 * indented by two spaces per level.
 */
export function flattenDiagnosticMessageText(
  messageText: string | DiagnosticMessageChain,
  newLine = '\n',
  indent = 0,
): string {
  if (typeof messageText === 'string') {
    return messageText;
  }
  let result = indent > 0 ? `${newLine}${'  '.repeat(indent)}` : '';
  result += messageText.messageText;
  for (const next of messageText.next ?? []) {
    result += flattenDiagnosticMessageText(next, newLine, indent + 1);
  }
  return result;
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

// The escape sequences of the classic formatter, which always colors its output (whether or not the
// output is a terminal). Callers strip them when they need plain text.
const RED = '\u001b[91m';
const YELLOW = '\u001b[93m';
const BLUE = '\u001b[94m';
const CYAN = '\u001b[96m';
const GREY = '\u001b[90m';
const GREEN = '\u001b[92m';
const GUTTER_STYLE = '\u001b[7m';
const RESET = '\u001b[0m';

function colored(style: string): (s: string | number) => string {
  return (s) => `${style}${s}${RESET}`;
}

const ansi = { cyan: colored(CYAN), grey: colored(GREY), yellow: colored(YELLOW) };

function categoryColor(category: DiagnosticCategory): (s: string) => string {
  switch (category) {
    case DiagnosticCategory.Error:
      return colored(RED);
    case DiagnosticCategory.Warning:
      return colored(YELLOW);
    case DiagnosticCategory.Suggestion:
      // The classic formatter refuses suggestions: main fails with "Debug Failure" when -vvv prints one
      // (aws/jsii-compiler#3002). The TypeScript 7 compiler deliberately does not copy that crash and prints the
      // suggestion, in the color `ts.DiagnosticCategory.Suggestion` would use.
      return colored(GREEN);
    default:
      return colored(BLUE);
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

/** `file:line:col`, relative to the project root (a file name that is not absolute is kept as is, like TypeScript does). */
function formatLocation(file: DiagnosticSourceFile, text: string | undefined, start: number | undefined, root: string) {
  let out = ansi.cyan(
    (path.isAbsolute(file.fileName) ? path.relative(root, file.fileName) : file.fileName) || file.fileName,
  );
  if (text != null && start != null) {
    const { line, character } = getLineAndCharacterOfPosition(text, start);
    out += `:${ansi.yellow(line + 1)}:${ansi.yellow(character + 1)}`;
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
  const gutter = (label: string) => `${indent}${colored(GUTTER_STYLE)(label.padStart(gutterWidth))} `;

  let out = '';
  for (let i = first.line; i <= last.line; i++) {
    out += '\n';
    if (hasMoreThanFiveLines && first.line + 1 < i && i < last.line - 1) {
      out += `${gutter(ELLIPSIS)}\n`;
      i = last.line - 1;
    }
    const lineContent = (lines[i] ?? '').trimEnd().replace(/\t/g, ' ');
    out += `${gutter(String(i + 1))}${lineContent}\n${gutter('')}`;
    let squiggle: string;
    if (i === first.line) {
      const end = i === last.line ? last.character : undefined;
      squiggle = lineContent.slice(0, first.character).replace(/\S/g, ' ');
      squiggle += lineContent.slice(first.character, end).replace(/./g, '~');
    } else if (i === last.line) {
      squiggle = lineContent.slice(0, last.character).replace(/./g, '~');
    } else {
      squiggle = lineContent.replace(/./g, '~');
    }
    out += color(squiggle);
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
  out += `${color(categoryName(diagnostic.category))}${ansi.grey(
    ` TS${diagnostic.code}: `,
  )}${flattenDiagnosticMessageText(diagnostic.messageText)}\n`;

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
          out += formatCodeSpan(infoText, info.start, info.length ?? 1, INDENT, ansi.cyan);
        }
      }
      out += `\n${INDENT}${flattenDiagnosticMessageText(info.messageText)}`;
    }
    out += '\n';
  }
  return out;
}
