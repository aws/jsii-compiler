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
and a removed `target` or `module` is not among the allowed values. Options TypeScript 7 no longer knows are ignored
(see below). `jsii rules strict` no longer lists the `must not be` entries for them. `esModuleInterop`,
`allowSyntheticDefaultImports` and `alwaysStrict` are still allowed as `true`.

**Why it cannot match:** TypeScript 7 removed these options and reports each one itself (TS5102, TS5108). The rules
only repeated that check with other words. The rule set stays, empty, for options a later TypeScript deprecates.

**Who is affected:** tools that parse the JSII4000 text or the `jsii rules` output. The same configurations pass and
fail as before, except those with an option TypeScript 7 no longer knows.

## Compiler options that TypeScript 7 no longer accepts are ignored

**What differs:** a user tsconfig is read by the TypeScript 7 config parser. It does not know the options TypeScript 7
removed (such as `importsNotUsedAsValues`, `charset`, `keyofStringsOnly`, `prepend`) and rejects values it no longer
supports (such as `target: "es3"` or `module: "none"`). `jsii` treats them like any unknown option or bad value on
`main`: they are left out. So they no longer show in a `JSII4000` violation (for example `importsNotUsedAsValues:
Unexpected field`; `target: "es3"` shows as `got: undefined`). With the `minimal` rule set or `off`, `target: "es3"`
no longer fails the build with `TS5108`; the default target is used instead.

**Why it cannot match:** TypeScript 7 has no such options or values, so its parser cannot give them back. Keeping them
would mean keeping a copy of TypeScript 6.0's option table in `jsii`.

**Who is affected:** projects whose tsconfig still sets an option or value that TypeScript 7 removed. `tsc` 7 rejects
these tsconfig files too.

## A bad option value does not override the value from `extends`

**What differs:** when a tsconfig sets an option to a value TypeScript rejects (such as `"declaration": "yes"`) and a
file it extends sets the same option, the value of the extended file is used. On `main`, the option is unset.
Options of an extended file are also listed after the file's own in a `JSII4000` violation; on `main` they come first.

**Why it cannot match:** this is how the TypeScript 7 config parser merges `extends`. It returns the merged options
sorted by name, and does not tell which file set an option.

**Who is affected:** only tsconfig files with a rejected value that also `extends` a file setting the same option, and
the order of the lines in a `JSII4000` error with several violations.

## Names of well-known symbol members in messages

**What differs:** a message that names a member declared with a well-known symbol, such as `[Symbol.iterator]()`,
prints TypeScript's internal name for it, and the number at its end differs. For
`export class A implements Iterable<string> { public [Symbol.iterator]() { ... } }`, JSII8006 reads:

- TypeScript 6.0: `Members with a name starting with "_" (e.g: "__@iterator@8") must be marked @internal`
- TypeScript 7: `Members with a name starting with "_" (e.g: "__@iterator@281474976710662") must be marked @internal`

**Why it cannot match:** the number is TypeScript's internal symbol id. Each compiler assigns its own, and it changes
with the program on both.

**Who is affected:** only the text of the message. The same members are reported, with the same code and location.
