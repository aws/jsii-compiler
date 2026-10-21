/**
 * Backend selection for the experimental TypeScript 7 (tsgo) backend.
 *
 * This module is intentionally dependency-free: `main.ts` imports it to decide
 * which code path to take WITHOUT loading the rest of the ts7 backend (and its
 * TypeScript 7 API loader) into the default path.
 */

/** The environment variable that selects the experimental backend. */
export const TS7_BACKEND_ENV = 'JSII_COMPILER_BACKEND';

/** Returns true when the ts7 backend has been requested via the env var. */
export function isTs7BackendEnabled(): boolean {
  return (process.env[TS7_BACKEND_ENV] ?? '').toLowerCase() === 'ts7';
}
