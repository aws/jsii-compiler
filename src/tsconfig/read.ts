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

/**
 * Reads a `tsconfig.json` file with TypeScript's own config parser, like the
 * classic compiler did with `ts.readConfigFile` and `ts.parseJsonConfigFileContent`:
 * `extends` is resolved, path options are absolute, and the compiler options
 * are in TypeScript's form (enum values as numbers; `convertForJson` gives the
 * JSON form the rule sets validate). The config file errors of the parse (a
 * broken `extends` base, options TypeScript rejects) are ignored, as the classic
 * compiler did; TypeScript leaves such bases and options out of the result.
 *
 * @param baseDir the directory that relative paths, `extends` and `${configDir}`
 *                are resolved against (default: the directory of the file). The
 *                compiler passes the project root, as the classic one did, even
 *                for a config in a subdirectory.
 */
export function readTypeScriptConfigFile(configPath: string, baseDir?: string): TypeScriptConfig {
  const absolutePath = path.resolve(configPath);
  const configDirectory = baseDir ?? path.dirname(absolutePath);
  const api = new (loadTypeScriptApi().API)({ cwd: configDirectory });
  try {
    const { config, error } = api.readConfigFile(absolutePath);
    if (error != null) {
      throw new TsconfigReadError(absolutePath, error);
    }
    const parsed = api.parseJsonConfigFileContent(config ?? {}, { configDirectory });
    // the tsconfig parser adds this in, but it is not an expected compilerOption
    const { configFilePath: _configFilePath, ...options } = parsed.options;
    return { compilerOptions: inFileOrder(options, parsed.raw?.compilerOptions), include: parsed.fileNames };
  } finally {
    api.close();
  }
}

/**
 * The options in the order the requested file lists them, then the others (from
 * `extends`, or added by the parser). The TypeScript 7 parser returns them sorted
 * by name; the rule sets report unexpected fields in the order of the options, and
 * the classic compiler kept the order of the file.
 */
// shortcut: options of an `extends` base come after the file's own (TS6 put them first, in the base's order); only
// the order of several violations from different files differs. Upgrade if a user reports it.
function inFileOrder(options: { [name: string]: unknown }, own: unknown): { [name: string]: unknown } {
  const ownNames = own != null && typeof own === 'object' ? Object.keys(own) : [];
  return Object.fromEntries(
    [
      ...ownNames.filter((name) => name in options),
      ...Object.keys(options).filter((name) => !ownNames.includes(name)),
    ].map((name) => [name, options[name]]),
  );
}
