import * as ts from 'typescript';

import { Code, JsiiDiagnostic } from './jsii-diagnostic';

/**
 * Set of silenced warning codes (numeric JSII codes).
 */
export const silencedWarnings = new Set<number>();

/**
 * Parse a user-provided warning identifier into numeric JSII codes.
 * Accepts: "JSII5019", "5019", or a diagnostic name / partial name.
 *
 * A name containing `/` must match a full diagnostic name exactly.
 * A name without `/` matches any diagnostic whose category or specific
 * name equals the input (e.g. "reserved-word" or "language-compatibility").
 */
export function parseWarningCodes(input: string): number[] {
  // JSII<number> format
  const jsiiMatch = /^JSII(\d+)$/i.exec(input);
  if (jsiiMatch) {
    return [parseInt(jsiiMatch[1], 10)];
  }

  // Plain number
  const num = parseInt(input, 10);
  if (String(num) === input) {
    return [num];
  }

  // Name-based lookup
  const matches = Code.lookupByPartialName(input);
  if (matches.length > 0) {
    return matches.map((c) => c.code);
  }

  throw new Error(
    `Unknown warning "${input}". Expected a JSII code (e.g. JSII5018), a number (e.g. 5018), or a diagnostic name (e.g. reserved-word, language-compatibility/reserved-word, language-compatibility).`,
  );
}

/**
 * Check if a diagnostic is a silenced warning.
 */
export function isSilenced(diagnostic: ts.Diagnostic): boolean {
  if (silencedWarnings.size === 0) {
    return false;
  }
  if (diagnostic.category !== ts.DiagnosticCategory.Warning) {
    return false;
  }
  if (!JsiiDiagnostic.isJsiiDiagnostic(diagnostic)) {
    return false;
  }
  return silencedWarnings.has(diagnostic.jsiiCode);
}
