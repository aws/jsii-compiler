import * as log4js from 'log4js';
import * as ts from 'typescript';

import { JsiiDiagnostic } from './jsii-diagnostic';

/**
 * Name of the logger for cli errors
 */
export const CLI_LOGGER = 'jsii/cli';
/**
 * Name of the logger for diagnostics information
 */
export const DIAGNOSTICS = 'diagnostics';
/**
 * Diagnostic code for JSII-generated messages.
 */
export const JSII_DIAGNOSTICS_CODE = 9999;

/**
 * Obtains the relevant logger to be used for a given diagnostic message.
 *
 * @param logger     the ``log4js.Logger`` to use for emitting the message.
 * @param diagnostic the message for which a logger is requested.
 *
 * @returns a logger method of the ``logger`` for the appropriate level.
 */
export function diagnosticsLogger(
  logger: log4js.Logger,
  diagnostic: ts.Diagnostic,
): ((message: any, ...args: any[]) => void) | undefined {
  switch (diagnostic.category) {
    case ts.DiagnosticCategory.Error:
      if (!logger.isErrorEnabled()) {
        return undefined;
      }
      return logger.error.bind(logger);
    case ts.DiagnosticCategory.Warning:
      if (!logger.isWarnEnabled()) {
        return undefined;
      }
      return logger.warn.bind(logger);
    case ts.DiagnosticCategory.Message:
      if (!logger.isDebugEnabled()) {
        return undefined;
      }
      return logger.debug.bind(logger);
    case ts.DiagnosticCategory.Suggestion:
    default:
      if (!logger.isTraceEnabled()) {
        return undefined;
      }
      return logger.trace.bind(logger);
  }
}

/**
 * Formats a diagnostic message with color and context, if possible.
 *
 * @param diagnostic  the diagnostic message ot be formatted.
 * @param projectRoot the root of the TypeScript project.
 *
 * @returns a formatted string.
 */
export function formatDiagnostic(diagnostic: ts.Diagnostic, projectRoot: string) {
  if (JsiiDiagnostic.isJsiiDiagnostic(diagnostic)) {
    // Ensure we leverage pre-rendered diagnostics where available.
    return diagnostic.format(projectRoot);
  }
  return _formatDiagnostic(diagnostic, projectRoot);
}

/**
 * Formats a diagnostic message with color and context, if possible. Users
 * should use `formatDiagnostic` instead, as this implementation is intended for
 * internal usafe only.
 *
 * @param diagnostic  the diagnostic message ot be formatted.
 * @param projectRoot the root of the TypeScript project.
 *
 * @returns a formatted string.
 */
export function _formatDiagnostic(diagnostic: ts.Diagnostic, projectRoot: string) {
  const formatDiagnosticsHost: ts.FormatDiagnosticsHost = {
    getCurrentDirectory: () => projectRoot,
    getCanonicalFileName: (fileName) => fileName,
    getNewLine: () => ts.sys.newLine,
  };

  const message =
    diagnostic.file != null
      ? ts.formatDiagnosticsWithColorAndContext([diagnostic], formatDiagnosticsHost)
      : ts.formatDiagnostic(diagnostic, formatDiagnosticsHost);

  if (!JsiiDiagnostic.isJsiiDiagnostic(diagnostic)) {
    return message;
  }

  // This is our own diagnostics, so we'll format appropriately (replacing TS#### with JSII####).
  return message.replace(` TS${JSII_DIAGNOSTICS_CODE}: `, ` JSII${diagnostic.jsiiCode}: `);
}

export function logDiagnostic(diagnostic: ts.Diagnostic, projectRoot: string) {
  const logFunc = diagnosticsLogger(log4js.getLogger(DIAGNOSTICS), diagnostic);
  if (!logFunc) {
    return;
  }
  logFunc(formatDiagnostic(diagnostic, projectRoot).trim());
}

const PERSON_REGEX = /^\s*(.+?)(?:\s*<([^>]+)>)?(?:\s*\(([^)]+)\))?\s*$/;
/**
 * Parses a string-formatted person entry from `package.json`.
 * @param value the string-formatted person entry.
 *
 * @example
 *  parsePerson("Barney Rubble <b@rubble.com> (http://barnyrubble.tumblr.com/)");
 *  // => { name: "Barney Rubble", email: "b@rubble.com", url: "http://barnyrubble.tumblr.com/" }
 */
export function parsePerson(value: string) {
  const match = PERSON_REGEX.exec(value);
  if (!match) {
    throw new JsiiError(`Invalid stringified "person" value: ${value}`);
  }
  const [, name, email, url] = match;
  const result: { name: string; email?: string; url?: string } = {
    name: name.trim(),
  };
  if (email) {
    result.email = email.trim();
  }
  if (url) {
    result.url = url.trim();
  }
  return result;
}

const REPOSITORY_REGEX = /^(?:(github|gist|bitbucket|gitlab):)?([A-Za-z\d_-]+\/[A-Za-z\d_-]+)$/;
export function parseRepository(value: string): { url: string } {
  const match = REPOSITORY_REGEX.exec(value);
  if (!match) {
    return { url: value };
  }
  const [, host, slug] = match;
  switch (host ?? 'github') {
    case 'github':
      return { url: `https://github.com/${slug}.git` };
    case 'gist':
      return { url: `https://gist.github.com/${slug}.git` };
    case 'bitbucket':
      return { url: `https://bitbucket.org/${slug}.git` };
    case 'gitlab':
      return { url: `https://gitlab.com/${slug}.git` };
    default:
      throw new JsiiError(`Unknown repository hosting service: ${host}`);
  }
}

const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(x: string): string {
  return x.replace(ANSI_REGEX, '');
}

/**
 * Maps the provided type to stip all `readonly` modifiers from its properties.
 */
export type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

/**
 * Throws an error that is intended as CLI output.
 */
export class JsiiError extends Error {
  /**
   * An expected error that can be nicely formatted where needed (e.g. in CLI output)
   * This should only be used for errors that a user can fix themselves.
   *
   * @param message The error message to be printed to the user.
   * @param showHelp Print the help before the error.
   */
  constructor(public override readonly message: string, public readonly showHelp = false) {
    super(message);
    Object.setPrototypeOf(this, JsiiError.prototype);
  }
}
