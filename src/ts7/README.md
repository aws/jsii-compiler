# Experimental TypeScript 7 (tsgo) backend

> This document records the architecture decision behind `src/ts7/`. The full
> feasibility analysis and measurement series are summarized in
> [this issue comment](https://github.com/aws/jsii-compiler/issues/1853#issuecomment-5338563660).

## What this is

An **experimental**, opt-in jsii backend that generates the `.jsii` assembly using
the out-of-process TypeScript 7 API (`@typescript/native-preview` / `tsgo`) instead
of the classic in-process compiler (`typescript`).

Enable it with:

```sh
JSII_COMPILER_BACKEND=ts7 jsii
```

The default backend is **completely unaffected** — the ts7 path is a separate
`Compiler.emitTs7()` method and lazily loads the toolchain.

## Toolchain

The backend runs against a `tsgo` + `@typescript/native-preview` client built from
[microsoft/typescript-go](https://github.com/microsoft/typescript-go), pinned to
the final commit of that staging repo (closed in August 2026 when the TypeScript 7
native port moved back into [microsoft/TypeScript](https://github.com/microsoft/TypeScript)).
All required APIs — including `checker.getFullyQualifiedName` (merged upstream in
PR 4700) and the whole-project `program.emit()` — are in that pin. A fork ref
carrying a not-yet-upstreamed **batched symbol-documentation API** can be used
instead as a faster option; without it the backend transparently falls back to
per-symbol documentation requests (same output, more round-trips).

Provision it with [`scripts/ts7-setup.sh`](../../scripts/ts7-setup.sh), which builds
the toolchain (or pulls a prebuilt tarball from an S3 cache) into `.ts7/`
(gitignored). Override locations with `JSII_TS7_DIR` / `JSII_TS7_NATIVE_PREVIEW` /
`TSGO_PATH`.

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

## Verification gate

Build `constructs` → `cloud-assembly-schema` → `aws-cdk-lib` with both backends
and diff the `.jsii` type space (see `scripts/ts7-compare-jsii.mjs`; target: 0
differences — achieved: 100% type/member parity, ~3.7x faster check+assemble on
aws-cdk-lib).
