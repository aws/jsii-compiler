# Experimental TypeScript 7 (tsgo) backend

> This document records the architecture decision behind `src/ts7/`. The full
> feasibility analysis and measurement series are summarized in
> [this issue comment](https://github.com/aws/jsii-compiler/issues/1853#issuecomment-5338563660).

## What this is

An **experimental**, opt-in jsii backend that generates the `.jsii` assembly using
the out-of-process TypeScript 7 programmatic API (`typescript/sync`, shipped in
the `typescript` package since 7.1) instead of the classic in-process compiler API.

Enable it with:

```sh
JSII_COMPILER_BACKEND=ts7 jsii
```

The default backend is **completely unaffected** — the ts7 path is a separate
`Compiler.emitTs7()` method and lazily loads the toolchain.

## Toolchain

The backend needs a `typescript` package **>= 7.1** (currently `7.1.0-beta`): that
release ships the programmatic API as the `typescript/sync` entry point, with the
native compiler binary in a platform-specific dependency. No Go toolchain or
source build is involved. Every API the backend uses is part of that surface
(`checker.getFullyQualifiedName`, `program.emit()`, the diagnostics getters, and
request batching via `api.batch(all(...))`, which replaces the earlier fork-only
batched documentation endpoint).

Because this compiler itself depends on the current TypeScript release line, the
7.x package is installed under an alias (this repository declares it as a
devDependency): 

```sh
npm i -D typescript7@npm:typescript@beta
```

The loader (`ts7-api.ts`) resolves the package in this order and fails with the
install one-liner above when nothing suitable is found:

1. `JSII_TS7_TYPESCRIPT` — directory of a `typescript` >= 7.1 package install
2. the `typescript7` alias, from the compiled project and then from jsii's own install
3. the project's regular `typescript` package, when it is >= 7.1

### Environment variables

| Variable | Purpose |
|---|---|
| `JSII_COMPILER_BACKEND=ts7` | Select the experimental backend (off by default). |
| `JSII_TS7_TYPESCRIPT` | Explicit directory of a `typescript` >= 7.1 package (overrides resolution). |
| `JSII_TS7_TIMING=1` | Log RPC request counts / bytes / server time after the run. |
| `JSII_TS7_NO_BATCH=1` | Disable request batching for documentation reads (measurement only). |
| `JSII_TS7_SKIP_TYPECHECK=1` | Skip the TypeScript diagnostics pass (measurement only; type errors are not detected). |

## Architecture decision

**Chosen: a directed, TS7-native re-implementation of the Assembler (`ts7/assembler.ts`),
NOT a facade over the 3500-line classic `Assembler`.**

Rationale:

1. **The goal of this experimental phase is to *prove* `.jsii` parity on the TS7
   API**, as fast and reliably as possible — not to unify the two compilers.
   Whether/how to unify them is a follow-up decision that should be made from
   parity data.
2. **A facade over the classic `Assembler` leaks everywhere.** The classic code
   assumes the in-process `ts.Program`/`ts.TypeChecker`/AST object model (e.g.
   `questionToken` vs the TS7 `postfixToken`, `JSDocTagInfo.text` object vs string,
   synchronous `symbol.declarations` vs `NodeHandle.resolve()`). Faking those
   shapes would be only partially correct and would break `node-bindings` WeakMap
   identity.
3. **The feasibility analysis's warning against shims is specifically about wrapping
   AST nodes** (which destroys WeakMap identity). A thin *checker/program facade*
   whose methods keep classic-compatible signatures but return the raw TS7 objects
   is a different thing and is fine — that is what `Ts7Host` provides.
4. `ts7/assembler.ts` is a structured port of a validated feasibility prototype,
   and reaches 100% type/member parity on aws-cdk-lib (~21k types).

To keep the eventual comparison tractable, `ts7/assembler.ts` mirrors the classic
`Assembler`'s method structure and names (`_visitClass`, `_visitInterface`,
`_visitEnum`, `_visitMethod`, `_visitProperty`, `_visitDocumentation`, …).

### Type strategy

This phase favours a working `.jsii` over precise typings: `Ts7Host` returns the
raw TS7 objects and the assembler reads them with loose (`any`) typings under an
experimental flag. Proper type abstraction is deferred until the API stabilizes.

## Out of scope / known divergences

- **jsii's own diagnostics.** Half the value of the classic `Assembler` is the
  `JSII_xxxx` error/warning suite it manufactures for invalid input
  (`src/jsii-diagnostic.ts`). The ts7 backend does **not** reproduce these; it
  targets normal-path parity only. TypeScript compilation errors ARE surfaced
  and fail the build (see `ts7/index.ts`).
- **symbolId remapping** through `tscRootDir`/`tscOutDir` for out-of-source
  builds consumed as dependencies.
- Watch mode (explicitly rejected with an error).
- `.warnings.jsii.js` generation (`--add-deprecation-warnings`) and the
  deprecated-remover emit surgery.
- The TypeScript 7 documentation APIs still differ from the classic ones in a few
  JSDoc edge cases (e.g. `Symbol.getJsDocTags` returns no tags for parameter
  symbols); the assembler reads `@param` text from source for those paths.

## Verification gate

Build `constructs` → `cloud-assembly-schema` → `aws-cdk-lib` with both backends
and diff the `.jsii` type space (see `scripts/ts7-compare-jsii.mjs`; target: 0
differences — achieved: 100% type/member parity, ~3.7x faster check+assemble on
aws-cdk-lib).
