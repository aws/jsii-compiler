import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import { convertForJson } from './compiler-options';
import type { CompilerOptionsJson, TypeScriptConfig } from './index';
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
 * Parses a `tsconfig.json` document. TypeScript accepts comments and trailing
 * commas in these files, so plain `JSON.parse` is not enough.
 */
export function parseTsconfigJson(text: string, fileName: string): any {
  try {
    return JSON.parse(stripJsonComments(text));
  } catch (e: any) {
    throw new JsiiError(`Failed to parse "${fileName}": ${e.message}`);
  }
}

/**
 * The JSON of the requested tsconfig file. What `JSON.parse` cannot take (or
 * takes but is not an object) goes to TypeScript's own parser, as with
 * `ts.readConfigFile` in the classic compiler: it accepts some files `JSON.parse`
 * rejects (an empty one), and reports TypeScript's error for the others.
 */
function readRequestedConfig(absolutePath: string): any {
  try {
    const own = JSON.parse(stripJsonComments(fs.readFileSync(absolutePath, 'utf8')));
    if (own != null && typeof own === 'object' && !Array.isArray(own)) {
      return own;
    }
  } catch {
    // TypeScript's parser decides below.
  }
  const api = new (loadTypeScriptApi().API)({ cwd: path.dirname(absolutePath) });
  try {
    const { config, error } = api.readConfigFile(absolutePath);
    if (error != null) {
      throw new TsconfigReadError(absolutePath, error);
    }
    return config ?? {};
  } finally {
    api.close();
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
 * Reads a `tsconfig.json` file and resolves its `extends` chain, returning the
 * effective configuration in its JSON form (the form the rule-set validator
 * operates on). Options of the extending file win over the extended ones;
 * `files` / `include` / `exclude` come from the nearest file that sets them,
 * with relative paths rebased onto the directory of the requested file. Path
 * valued `compilerOptions` are made absolute, as TypeScript's own parser does.
 * A base that cannot be resolved or read is skipped, as the classic compiler did.
 * Compiler options are kept as written; TypeScript 7 reports the ones it rejects.
 *
 * @param baseDir the directory that relative paths and `extends` in the requested
 *                file are resolved against (default: the directory of the file).
 *                The compiler passes the project root, as the classic one did, even
 *                for a config in a subdirectory. Files it extends use their own.
 */
export function readTypeScriptConfigFile(configPath: string, baseDir?: string): TypeScriptConfig {
  const absolutePath = path.resolve(configPath);
  const seen = new Set<string>();
  const rootDir = baseDir ?? path.dirname(absolutePath);
  const result = readOne(absolutePath, seen, path.dirname(absolutePath), rootDir, true);
  delete (result as any).extends;
  return {
    ...result,
    compilerOptions: convertForJson(substituteConfigDir(result.compilerOptions, rootDir)),
  };
}

function readOne(
  absolutePath: string,
  seen: Set<string>,
  targetDir: string,
  baseDir?: string,
  requested = false,
): TypeScriptConfig {
  if (seen.has(absolutePath)) {
    throw new JsiiError(`Circular "extends" in tsconfig: ${absolutePath}`);
  }
  seen.add(absolutePath);
  let own: any;
  if (requested) {
    own = readRequestedConfig(absolutePath);
  } else {
    let text: string;
    try {
      text = fs.readFileSync(absolutePath, 'utf8');
    } catch (e: any) {
      throw new JsiiError(`Failed to read tsconfig at "${absolutePath}": ${e.message}`);
    }
    own = parseTsconfigJson(text, absolutePath) ?? {};
  }
  const ownDir = baseDir ?? path.dirname(absolutePath);

  let merged: TypeScriptConfig = { compilerOptions: {} };
  const bases: string[] = own.extends == null ? [] : Array.isArray(own.extends) ? own.extends : [own.extends];
  for (const base of bases) {
    try {
      const resolved = resolveExtends(base, ownDir);
      merged = mergeConfigs(merged, readOne(resolved, new Set(seen), targetDir));
    } catch (e: any) {
      // @TODO(NEXT): a missing, unparseable or circular base is skipped silently; tsc and TS7 fail with TS5083 / TS18000
      // (aws/jsii-compiler#2991, #2982). After 7.1's first release: report it (JSII4000 or the TS diagnostic) instead.
      // Like TypeScript's parser, which reports a base it cannot resolve, read or
      // parse (or a circular chain) as a config error that the classic compiler
      // dropped: carry on without that base.
      if (!(e instanceof JsiiError)) {
        throw e;
      }
    }
  }

  const ownRebased: TypeScriptConfig = {
    ...own,
    compilerOptions: resolveCompilerOptions(own.compilerOptions ?? {}, ownDir),
    ...(own.files ? { files: own.files.map((f: string) => rebase(f, ownDir, targetDir)) } : {}),
    ...(own.include ? { include: own.include.map((f: string) => rebase(f, ownDir, targetDir)) } : {}),
    ...(own.exclude ? { exclude: own.exclude.map((f: string) => rebase(f, ownDir, targetDir)) } : {}),
  };
  return mergeConfigs(merged, ownRebased);
}

function mergeConfigs(base: TypeScriptConfig, override: TypeScriptConfig): TypeScriptConfig {
  return {
    ...base,
    ...override,
    compilerOptions: { ...base.compilerOptions, ...override.compilerOptions },
    ...(base.watchOptions || override.watchOptions
      ? { watchOptions: { ...base.watchOptions, ...override.watchOptions } }
      : {}),
  };
}

/**
 * Options TypeScript treats as file paths (`isFilePath` in its option table):
 * `parseJsonConfigFileContent` turns them into absolute paths, relative to the
 * directory of the file that sets them.
 */
const PATH_OPTIONS = new Set([
  'outDir',
  'rootDir',
  'baseUrl',
  'declarationDir',
  'tsBuildInfoFile',
  'outFile',
  'generateTrace',
  'generateCpuProfile',
  'project',
]);
const PATH_LIST_OPTIONS = new Set(['rootDirs', 'typeRoots']);

/** A path starting with this is relative to the tsconfig that gets compiled, not to the file that sets it. */
const CONFIG_DIR_TEMPLATE = '${configDir}';

/**
 * Resolves the path-valued options of one tsconfig file, like TypeScript does:
 * relative paths become absolute (with forward slashes), and `paths` records the
 * directory it is relative to as `pathsBasePath`.
 */
function resolveCompilerOptions(options: CompilerOptionsJson, fromDir: string): CompilerOptionsJson {
  const out: CompilerOptionsJson = {};
  for (const [key, value] of Object.entries(options)) {
    if (PATH_OPTIONS.has(key) && typeof value === 'string') {
      out[key] = resolvePath(value, fromDir);
    } else if (PATH_LIST_OPTIONS.has(key) && Array.isArray(value)) {
      out[key] = value.map((v) => (typeof v === 'string' ? resolvePath(v, fromDir) : v));
    } else {
      out[key] = value;
    }
  }
  // @TODO(NEXT): `pathsBasePath` is internal to TypeScript but ends up in the config the rule sets see, so `strict`
  // fails on `paths` (aws/jsii-compiler#2992). After 7.1's first release: keep it out of the validated options.
  if (out.paths != null) {
    out.pathsBasePath = toPosix(fromDir);
  }
  return out;
}

function resolvePath(p: string, fromDir: string): string {
  return p.startsWith(CONFIG_DIR_TEMPLATE) ? p : toPosix(path.resolve(fromDir, p));
}

/** Replaces `${configDir}` in the path options of the final configuration. */
function substituteConfigDir(options: CompilerOptionsJson, configDir: string): CompilerOptionsJson {
  const substitute = (p: string) =>
    p.startsWith(CONFIG_DIR_TEMPLATE) ? toPosix(path.resolve(configDir, p.replace(CONFIG_DIR_TEMPLATE, './'))) : p;
  const out: CompilerOptionsJson = { ...options };
  for (const [key, value] of Object.entries(out)) {
    if (PATH_OPTIONS.has(key) && typeof value === 'string') {
      out[key] = substitute(value);
    } else if (PATH_LIST_OPTIONS.has(key) && Array.isArray(value)) {
      out[key] = value.map((v) => (typeof v === 'string' ? substitute(v) : v));
    }
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function rebase(p: string, fromDir: string, toDir: string): string {
  if (path.isAbsolute(p)) {
    return p;
  }
  const rel = path.relative(toDir, path.resolve(fromDir, p));
  return rel.split(path.sep).join('/');
}

function resolveExtends(spec: string, fromDir: string): string {
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    const candidate = path.resolve(fromDir, spec);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    if (fs.existsSync(`${candidate}.json`)) {
      return `${candidate}.json`;
    }
    if (fs.existsSync(path.join(candidate, 'tsconfig.json'))) {
      return path.join(candidate, 'tsconfig.json');
    }
    throw new JsiiError(`Cannot resolve "extends": "${spec}" from ${fromDir}`);
  }
  const req = createRequire(path.join(fromDir, 'package.json'));
  const attempts = [spec, `${spec}.json`, `${spec}/tsconfig.json`];
  for (const attempt of attempts) {
    try {
      return req.resolve(attempt);
    } catch {
      /* try the next shape */
    }
  }
  throw new JsiiError(`Cannot resolve "extends": "${spec}" from ${fromDir}`);
}
