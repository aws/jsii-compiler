import * as path from 'node:path';

import type { TypeScriptConfig } from './index';
import { loadTypeScriptApi } from '../compiler-host';
import { JsiiError } from '../utils';

/**
 * A requested tsconfig file that TypeScript cannot read or parse, with
 * TypeScript's error (a diagnostic of the TypeScript 7 API, such as TS1005 or
 * TS5083), as the classic compiler got it from `ts.readConfigFile`.
 */
export class TsconfigReadError extends JsiiError {
  public constructor(public readonly configPath: string, public readonly diagnostic: any) {
    super(`Failed to read tsconfig at "${configPath}": ${diagnostic.text ?? diagnostic.messageText}`);
    // JsiiError sets its own prototype; restore this one so `instanceof TsconfigReadError` works.
    Object.setPrototypeOf(this, TsconfigReadError.prototype);
  }
}

/**
 * Parses a `tsconfig.json` document for the files jsii only looks into (its own
 * generated file, the tsconfig of a monorepo peer). TypeScript accepts comments
 * and trailing commas in these files, so plain `JSON.parse` is not enough. This
 * runs in-process, so that these reads need no TypeScript 7 process.
 */
export function parseTsconfigJson(text: string, fileName: string): any {
  try {
    return JSON.parse(stripJsonComments(text));
  } catch (e: any) {
    throw new JsiiError(`Failed to parse "${fileName}": ${e.message}`);
  }
}

function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      // copy the string literal verbatim
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          j++;
        }
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  // trailing commas before a closing bracket/brace
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** A tsconfig as TypeScript's config parser reads it, with the errors it found. */
export interface TsconfigReadResult {
  readonly config: TypeScriptConfig;
  /**
   * TypeScript's errors for the tsconfig and the files it `extends`: unknown
   * options, bad values, a base that cannot be found, read or parsed, circular
   * `extends`. Not "no inputs" (TS18002, TS18003): those are about the source files.
   */
  readonly errors: readonly any[];
}

/** "The 'files' list in config file is empty" and "No inputs were found in config file". */
const NO_INPUTS_ERRORS = new Set([18002, 18003]);

/**
 * Reads a `tsconfig.json` file with TypeScript's own config parser, like `tsc`:
 * `extends` is resolved, path options are absolute (relative to the file's own
 * directory), and the compiler options are in TypeScript's form (enum values as
 * numbers; `convertForJson` gives the JSON form the rule sets validate).
 * TypeScript leaves rejected options and broken `extends` bases out of the
 * result, and reports them in `errors`.
 *
 * @throws {@link TsconfigReadError} when the file itself cannot be read or parsed
 */
export function readTypeScriptConfigFile(configPath: string): TsconfigReadResult {
  const absolutePath = path.resolve(configPath);
  const api = new (loadTypeScriptApi().API)({ cwd: path.dirname(absolutePath) });
  try {
    // `parseConfigFile` fails for a file it cannot read; `readConfigFile` reports why, like the classic compiler.
    const { error } = api.readConfigFile(absolutePath);
    if (error != null) {
      throw new TsconfigReadError(absolutePath, error);
    }
    // Parsed from the file, so that the errors point into it.
    const parsed = api.parseConfigFile(absolutePath);
    // the tsconfig parser adds this in, but it is not an expected compilerOption
    const { configFilePath: _configFilePath, ...options } = parsed.options;
    return {
      config: { compilerOptions: inFileOrder(options, parsed.raw?.compilerOptions), include: parsed.fileNames },
      errors: parsed.errors.filter((d: any) => !NO_INPUTS_ERRORS.has(d.code)),
    };
  } finally {
    api.close();
  }
}

/** A tsconfig with errors TypeScript reports for it (see {@link TsconfigReadResult.errors}). */
export class TsconfigErrors extends JsiiError {
  public constructor(public readonly configPath: string, public readonly diagnostics: readonly any[]) {
    super(`The tsconfig at "${configPath}" has errors: ${diagnostics.map((d) => d.text).join('; ')}`);
    // JsiiError sets its own prototype; restore this one so `instanceof TsconfigErrors` works.
    Object.setPrototypeOf(this, TsconfigErrors.prototype);
  }
}

/**
 * Puts the options in the order the requested file lists them. The options that
 * come from `extends`, or that the parser adds, follow in the order they arrive.
 * The TypeScript 7 parser returns the options sorted by name. The rule sets report
 * unexpected fields in the order of the options, and the classic compiler kept the
 * order of the file.
 */
// shortcut: TypeScript 6 put the options of an `extends` base first, in the base's order; here they come last. This
// only changes the order of several violations from different files. Upgrade if a user reports it.
function inFileOrder(options: { [name: string]: unknown }, own: unknown): { [name: string]: unknown } {
  const ownNames = own != null && typeof own === 'object' ? Object.keys(own) : [];
  return Object.fromEntries(
    [
      ...ownNames.filter((name) => name in options),
      ...Object.keys(options).filter((name) => !ownNames.includes(name)),
    ].map((name) => [name, options[name]]),
  );
}
