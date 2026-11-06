/**
 * Jest transformer that runs ts-jest against TypeScript 6.
 *
 * ts-jest drives the classic in-process compiler API (`ts.createProgram`,
 * `ts.transpileModule`, the `ModuleKind` enum, ...). The `typescript` package
 * this project depends on is TypeScript 7, whose main entry point no longer
 * exposes that API, and ts-jest `require`s `typescript` by name from several of
 * its own modules, so its `compiler` option alone is not enough.
 *
 * This shim redirects `require('typescript')` issued from inside ts-jest to the
 * `typescript6` alias package (a tooling-only devDependency; the compiler itself
 * is built with TypeScript 7) before loading ts-jest. Nothing else is affected:
 * the hook only matches requests whose parent module lives under `ts-jest`.
 *
 * Remove once ts-jest supports the TypeScript 7 API.
 */
const Module = require('node:module');
const path = require('node:path');

const typescript6 = path.dirname(require.resolve('typescript6/package.json'));
const tsJestDir = `${path.sep}ts-jest${path.sep}`;

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if ((request === 'typescript' || request.startsWith('typescript/')) && parent?.filename?.includes(tsJestDir)) {
    request = request.replace(/^typescript/, typescript6);
  }
  return originalResolveFilename.call(this, request, parent, ...rest);
};

module.exports = require('ts-jest');
