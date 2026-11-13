import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import { convertForJson } from './compiler-options';
import type { CompilerOptionsJson, TypeScriptConfig } from './index';
import { JsiiError } from '../utils';

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
 * with relative paths rebased onto the directory of the requested file.
 */
export function readTypeScriptConfigFile(configPath: string): TypeScriptConfig {
  const absolutePath = path.resolve(configPath);
  const seen = new Set<string>();
  const result = readOne(absolutePath, seen, path.dirname(absolutePath));
  delete (result as any).extends;
  return { ...result, compilerOptions: convertForJson(result.compilerOptions) };
}

function readOne(absolutePath: string, seen: Set<string>, targetDir: string): TypeScriptConfig {
  if (seen.has(absolutePath)) {
    throw new JsiiError(`Circular "extends" in tsconfig: ${absolutePath}`);
  }
  seen.add(absolutePath);
  let text: string;
  try {
    text = fs.readFileSync(absolutePath, 'utf8');
  } catch (e: any) {
    throw new JsiiError(`Failed to read tsconfig at "${absolutePath}": ${e.message}`);
  }
  const own = parseTsconfigJson(text, absolutePath) ?? {};
  const ownDir = path.dirname(absolutePath);

  let merged: TypeScriptConfig = { compilerOptions: {} };
  const bases: string[] = own.extends == null ? [] : Array.isArray(own.extends) ? own.extends : [own.extends];
  for (const base of bases) {
    const resolved = resolveExtends(base, ownDir);
    const baseConfig = readOne(resolved, new Set(seen), targetDir);
    merged = mergeConfigs(merged, baseConfig);
  }

  const ownRebased: TypeScriptConfig = {
    ...own,
    compilerOptions: rebaseCompilerOptions(own.compilerOptions ?? {}, ownDir, targetDir),
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

const PATH_OPTIONS = new Set(['outDir', 'rootDir', 'baseUrl', 'declarationDir', 'tsBuildInfoFile', 'outFile']);
const PATH_LIST_OPTIONS = new Set(['rootDirs', 'typeRoots']);

function rebaseCompilerOptions(options: CompilerOptionsJson, fromDir: string, toDir: string): CompilerOptionsJson {
  if (fromDir === toDir) {
    return { ...options };
  }
  const out: CompilerOptionsJson = {};
  for (const [key, value] of Object.entries(options)) {
    if (PATH_OPTIONS.has(key) && typeof value === 'string') {
      out[key] = rebase(value, fromDir, toDir);
    } else if (PATH_LIST_OPTIONS.has(key) && Array.isArray(value)) {
      out[key] = value.map((v) => (typeof v === 'string' ? rebase(v, fromDir, toDir) : v));
    } else {
      out[key] = value;
    }
  }
  return out;
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
