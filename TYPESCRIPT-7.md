# jsii on TypeScript 7

The `preview/v7.1` branch builds `jsii` on TypeScript 7.1, the native port of the TypeScript compiler, through its new
programmatic API. Builds are published as dev pre-releases under the `v7.1-next` dist-tag (see the
[README](./README.md#typescript-7)).

The goal of this branch is parity with `jsii` on TypeScript 6.0 (the `main` branch). For the same project, the
TypeScript 7 compiler should give the same exit code, the same output, the same `.jsii` assembly and the same files.
Where `main` behaves oddly, the TypeScript 7 compiler copies it for now, and the code carries a note on what to change
after the first 7.1 release.

Some differences cannot reasonably be removed on TypeScript 7. They are listed below. Each entry says what differs,
why it cannot match, and who is affected.

## `tsconfig.tsbuildinfo` is not written

**What differs:** with `incremental` builds, `jsii` on TypeScript 6.0 writes TypeScript's build info file. For a
generated `tsconfig.json` that is `<outDir>/tsconfig.tsbuildinfo`; for a user tsconfig it is the file set in
`tsBuildInfoFile`. The TypeScript 7 compiler writes no build info file. The emitted `.js`, `.d.ts` and `.jsii` files are
the same.

**Why it cannot match:** `program.emit` in the TypeScript 7 API never writes build info, whatever the compiler options
say. Writing the file from `jsii` would mean producing TypeScript's private, version-specific build info format
ourselves.

**Who is affected:** projects that rely on incremental rebuilds. Every build is a full build, so a rebuild is not faster.
Nothing else changes, and clean scripts or `.gitignore` entries for the file do no harm.

## Emitted source maps differ

**What differs:** the inline source map in every emitted `.js` file comes from the TypeScript 7 emitter. It has no
`"sourceRoot":""` entry, and its `mappings` differ slightly (for example, `export` is mapped onto `class`). The code
itself and the `.d.ts` files are the same.

**Why it cannot match:** the mappings are written by the TypeScript printer. Producing the TypeScript 6.0 mappings would
need the TypeScript 6.0 printer.

**Who is affected:** nobody at runtime. Debuggers and stack-trace tools read both maps. Only tools that compare the
bytes of the source maps see a difference.

## The `strict` rule set reports removed options differently

**What differs:** `jsii` on TypeScript 6.0 has rules for the options TypeScript 6.0 deprecates (`target: es5`,
`module: amd`, `moduleResolution: node`, `downlevelIteration`, `baseUrl`, `esModuleInterop: false`, ...). On TypeScript
7 the deprecated-options rule set is empty. These options still fail `strict` validation, but with the general rules:
an option TypeScript 7 removed but still reads (such as `downlevelIteration` or `baseUrl`) is an `Unexpected field`,
and a removed `target` or `module` is not among the allowed values. Options TypeScript 7 no longer knows fail the build
(see below). `jsii rules strict` no longer lists the `must not be` entries for them. `esModuleInterop`,
`allowSyntheticDefaultImports` and `alwaysStrict` are still allowed as `true`.

**Why it cannot match:** TypeScript 7 removed these options and reports each one itself (TS5102, TS5108). The rules
only repeated that check with other words. The rule set stays, empty, for options a later TypeScript deprecates.

**Who is affected:** tools that parse the JSII4000 text or the `jsii rules` output. The same configurations pass and
fail as before.

## Rejected compiler options in a user tsconfig are errors

**What differs:** in a user tsconfig (`--tsconfig`), an unknown compiler option (TS5023), a value of the wrong type
(TS5024) or a value that is not allowed (TS6046) fails the build with TypeScript's error, as `tsc` reports it. That
includes the options and values TypeScript 7 removed, such as `importsNotUsedAsValues`, `charset`, `prepend`,
`target: "es3"` or `module: "none"`. `jsii` on TypeScript 6.0 drops unknown options and bad values silently and builds.
tsconfig validation runs on the options TypeScript accepted, so a rejected option is not a `JSII4000` violation (for
example `importsNotUsedAsValues: Unexpected field` on `main`); a rejected value shows as `got: undefined`, as on `main`.

**Why it cannot match:** `main` gets this from TypeScript 6.0's option parser. TypeScript 7 knows a different set of
options, so matching `main` meant shipping a copy of TypeScript 6.0's option table. Reporting what TypeScript 7 rejects
is what `tsc` does.

**Who is affected:** projects whose user tsconfig has a typo or an option TypeScript 7 does not know. They fix the
tsconfig. Generated tsconfigs are not affected. A rejected option in a file the tsconfig `extends` is still skipped
silently, like a broken `extends`.

## Options from `extends` are listed after the file's own

**What differs:** in a `JSII4000` error with several violations, those for options set in a file the tsconfig
`extends` come after those for the file's own options. On `main` they come first.

**Why it cannot match:** the TypeScript 7 config parser returns the merged options sorted by name, and does not tell
which file set an option. `jsii` puts the file's own options first, in their order.

**Who is affected:** tools that parse the `JSII4000` text of a tsconfig that `extends` another.
