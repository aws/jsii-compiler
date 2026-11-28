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
`tsBuildInfoFile`. The TypeScript 7 compiler writes no build info file. The emitted `.js`, `.d.ts` and `.jsii` files do
not change because of it.

**Why it cannot match:** `program.emit` in the TypeScript 7 API never writes build info, whatever the compiler options
say. Writing the file from `jsii` would mean producing TypeScript's private, version-specific build info format
ourselves.

**Who is affected:** projects that rely on incremental rebuilds. Every build is a full build, so a rebuild is not faster.
Nothing else changes, and clean scripts or `.gitignore` entries for the file do no harm.

## `incremental` without `tsBuildInfoFile` builds

**What differs:** a user tsconfig with `"incremental": true` and no `tsBuildInfoFile` builds, as it does with `tsc -p`.
On `main`, `jsii` fails with `error TS5074: Option '--incremental' can only be specified using tsconfig, emitting to
single file or when option '--tsBuildInfoFile' is specified.` and emits nothing.

**Why it differs:** this is a `main` bug ([aws/jsii-compiler#3025](https://github.com/aws/jsii-compiler/issues/3025)):
`jsii` on TypeScript 6.0 hands the options to TypeScript without the tsconfig they came from, so TypeScript rejects
them. The TypeScript 7 compiler builds from the tsconfig itself. Copying the error would mean making it up. As above,
no build info file is written.

**Who is affected:** projects with such a tsconfig, which fail on `main` and build on TypeScript 7.

## Emitted source maps differ

**What differs:** the inline source map in every emitted `.js` file comes from the TypeScript 7 emitter. It has no
`"sourceRoot":""` entry, and its `mappings` differ slightly (for example, `export` is mapped onto `class`). The code
itself is the same. (The `.d.ts` files can differ where types are inferred; see the next entry.)

**Why it cannot match:** the mappings are written by the TypeScript printer. Producing the TypeScript 6.0 mappings would
need the TypeScript 6.0 printer.

**Who is affected:** nobody at runtime. Debuggers and stack-trace tools read both maps. Only tools that compare the
bytes of the source maps see a difference.

## Emitted `.d.ts` can differ where types are inferred

**What differs:** where a declaration has no type written in the source, the `.d.ts` file holds the type TypeScript
infers, printed by TypeScript. TypeScript 7 sometimes prints it in another way. In `aws-cdk-lib`, 6 of 2,744 `.d.ts`
files differ from `jsii` on TypeScript 6.0. Two examples:

```ts
// export function defaultSubnetName(type: SubnetType) { ... return 'Public'; ... return 'Private'; ... }
export declare function defaultSubnetName(type: SubnetType): "Public" | "Private" | "Isolated"; // TypeScript 6.0
export declare function defaultSubnetName(type: SubnetType): "Isolated" | "Private" | "Public"; // TypeScript 7

// export const TOKEN_VAULT_CREDENTIAL_SECRET_WRITE_PERMS = ['secretsmanager:PutSecretValue'] as const;
export declare const TOKEN_VAULT_CREDENTIAL_SECRET_WRITE_PERMS: readonly ["secretsmanager:PutSecretValue"]; // 6.0
export declare const TOKEN_VAULT_CREDENTIAL_SECRET_WRITE_PERMS: readonly ['secretsmanager:PutSecretValue']; // 7
```

Another inferred case is the order of the properties of an object type built with a spread. Two cases come from a
type written in the source, which TypeScript 6.0 printed again: `pattern?: any` (6.0: `pattern?: any | undefined`),
and `gateway: IGateway` (6.0: `gateway: bedrockagentcore.IGateway`, through another import of the same type).

**Why it cannot match:** `jsii` does not write these types. The TypeScript 7 declaration emitter infers and prints them,
and its printer orders union members, keeps quotes and reuses the source text in its own way. Producing the
TypeScript 6.0 text would need the TypeScript 6.0 checker and printer.

**Who is affected:** nobody who uses the types. The two texts describe the same types, so code type-checks the same
against either. Only tools that compare the bytes of `.d.ts` files see a difference.

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

## tsconfig errors are reported

**What differs:** `jsii` reports TypeScript's errors for a user tsconfig (`--tsconfig`, or `jsii.tsconfig` in
`package.json`) and for the files it `extends`, the way `tsc` does. The build fails (exit code 1) and the errors count in
the summary. `jsii validate-tsconfig` prints the same errors and fails (exit code 1) instead of validating the options,
as `tsc --showConfig` does on TypeScript 6.0. On `main`, `jsii` drops these errors, skips what they are about and builds.

| Case | `main` | TypeScript 7 |
|---|---|---|
| Unknown option, or one TypeScript 7 removed (`importsNotUsedAsValues`, `charset`, `prepend`, ...) | ignored, `✨ Successful`; `strict` reports a removed option as `Unexpected field` | `tsconfig.json:15:3 - error TS5023: Unknown compiler option 'bogusOption'.` |
| Value of the wrong type (`"declaration": "yes"`) | `strict`: `declaration: Expected value true, got: undefined`; other rule sets: ignored | `tsconfig.json:4:18 - error TS5024: Compiler option 'declaration' requires a value of type boolean.` |
| Value that is not allowed (`"target": "es1999"`, or `es3` and `module: "none"`, which TypeScript 7 removed) | `strict`: `target: ... got: undefined`; other rule sets: ignored, the default is used | `tsconfig.json:14:13 - error TS6046: Argument for '--target' option must be: 'es6', ...` |
| `extends` a file that does not exist | ignored, `✨ Successful` | `error TS5083: Cannot read file '<dir>/missing.json'.` |
| `extends` a file that cannot be parsed | ignored, `✨ Successful` | `base.json:1:29 - error TS1109: Expression expected.` (with TS1005, TS1328, ...) |
| Circular `extends` | ignored, `✨ Successful` | `error TS18000: Circularity detected while resolving configuration: {0}` |
| A rejected option in a file the tsconfig `extends` | ignored, `✨ Successful` | `base.json:1:21 - error TS5023: Unknown compiler option 'bogus'.` |
| Every input excluded (for example `outDir` equal to `rootDir`, so `include` matches nothing) | `error JSII0004: Could not find "main" file: <dir>/lib/index.ts` only | `error TS18003: No inputs were found in config file '<dir>/tsconfig.json'. ...` next to the JSII0004 |
| `--tsconfig sub/tsconfig.json` with a relative `extends` or relative paths | resolved against the project root, so the base is not found and skipped | resolved against `sub/`, like `tsc` |

With such errors, the rule set is not checked: the `JSII4000` violations for the options TypeScript could read come once
the errors are fixed. The TS18000 text ends in a literal `{0}` in TypeScript 7.1.0-beta, where TypeScript 6.0 prints
the chain of files; that is a TypeScript 7 bug.

**Why it differs:** these are TypeScript's own errors. `jsii` on TypeScript 6.0 read the tsconfig itself and dropped
them (aws/jsii-compiler#2982, #2991, #3029). Matching that on TypeScript 7 meant hiding the errors of the TypeScript 7
program and keeping a copy of TypeScript 6.0's option table. `jsii` on TypeScript 7 follows `tsc` instead.

**Who is affected:** projects with a broken user tsconfig that built before: a typo in an option, a value or an option
TypeScript 7 removed, or a broken `extends`. They fix the tsconfig. Generated tsconfigs are not affected.

## Options from `extends` are listed after the file's own

**What differs:** in a `JSII4000` error with several violations, those for options set in a file the tsconfig
`extends` come after those for the file's own options. On `main` they come first.

**Why it cannot match:** the TypeScript 7 config parser returns the merged options sorted by name, and does not tell
which file set an option. `jsii` puts the file's own options first, in their order.

**Who is affected:** tools that parse the `JSII4000` text of a tsconfig that `extends` another.

## Names of well-known symbol members in messages

**What differs:** a message that names a member declared with a well-known symbol, such as `[Symbol.iterator]()`,
prints TypeScript's internal name for it, and the number at its end differs. For
`export class A implements Iterable<string> { public [Symbol.iterator]() { ... } }`, JSII8006 reads:

- TypeScript 6.0: `Members with a name starting with "_" (e.g: "__@iterator@8") must be marked @internal`
- TypeScript 7: `Members with a name starting with "_" (e.g: "__@iterator@281474976710662") must be marked @internal`

**Why it cannot match:** the number is TypeScript's internal symbol id. Each compiler assigns its own, and it changes
with the program on both.

**Who is affected:** only the text of the message. The same members are reported, with the same code and location.
