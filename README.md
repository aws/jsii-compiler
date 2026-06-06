# ![jsii](https://raw.githubusercontent.com/aws/jsii-compiler/main/logo/png/128.png)

[![Join the chat at https://cdk.Dev](https://img.shields.io/static/v1?label=Slack&message=cdk.dev&color=brightgreen&logo=slack)](https://cdk.dev)
[![Build Status](https://github.com/aws/jsii-compiler/workflows/build/badge.svg)](https://github.com/aws/jsii-compiler/actions?query=workflow%3Abuild+branch%3Amain)
[![npm](https://img.shields.io/npm/v/jsii?logo=npm)](https://www.npmjs.com/package/jsii)
[![docker](https://img.shields.io/badge/docker-jsii%2Fsuperchain-brightgreen?logo=docker)](https://hub.docker.com/r/jsii/superchain)

## Overview

`jsii` allows code in any language to naturally interact with JavaScript classes. It is the technology that enables the
[AWS Cloud Development Kit][cdk] to deliver polyglot libraries from a single codebase!

[cdk]: https://github.com/aws/aws-cdk

A class library written in **TypeScript** can be used in projects authored in **TypeScript** or **Javascript** (as
usual), but also in **Python**, **Java**, **C#** (and other languages from the _.NET_ family), ...

## :gear: Support & Maintenance

Head over to our [documentation website](https://aws.github.io/jsii)!

Our _Maintenance & Support policy_ can be reviewed in [SUPPORT.md](./SUPPORT.md).
The current status of `jsii` compiler releases is:

| Release | Status      | EOS        | Comment                                                                                 |
| ------- | ----------- | ---------- | --------------------------------------------------------------------------------------- |
| `6.0.x` | Current     | TBD        | ![npm](https://img.shields.io/npm/v/jsii/v6.0-latest?label=jsii%40v6.0-latest&logo=npm) |
| `5.9.x` | Maintenance | 2027-01-01 | ![npm](https://img.shields.io/npm/v/jsii/v5.9-latest?label=jsii%40v5.9-latest&logo=npm) |

### :arrow_up: Upgrading to jsii 6.0

`jsii` 6.0 adopts [TypeScript 6.0][ts-6.0-announcement]. The actions below are driven by TypeScript 6.0's new defaults
and deprecations; see the [TypeScript 6.0 announcement][ts-6.0-announcement] and the
[Node Target Mapping][ts-node-target-mapping] notes for the upstream details.

[ts-6.0-announcement]: https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/
[ts-node-target-mapping]: https://github.com/microsoft/TypeScript/wiki/Node-Target-Mapping

#### If jsii generates your `tsconfig.json`

This is the default. After upgrading, work through the following:

- **Check your `package.json` `"type"` field.** `module` is now `node20`, so TypeScript decides whether each file is
  CommonJS or ESM from `"type"`. Leave it unset (or `"commonjs"`) to keep CommonJS output; only set `"type": "module"`
  if you intend to ship ESM. Then fix any new per-file module errors this surfaces — this is the most impactful change.
- **Adjust your imports.** `esModuleInterop` is always enabled now, so update namespace imports that were used as a
  default — e.g. change `import * as express from "express"` to `import express from "express"`.
- **Fix unresolved side-effect imports.** `noUncheckedSideEffectImports` is enabled, so a side-effect-only import — one
  with no bindings, e.g. `import "./register-handlers"` — now errors if its path does not resolve. Correct the path or
  remove the import (previously a misspelled path was accepted silently).
- **Add `declare` to redeclared properties.** With the `ES2023` `target`/`lib`, class fields use define semantics; if a
  subclass restates a property from its base, mark it `declare` (or give it an initializer).
- **Optionally pin your types.** `types` defaults to `["*"]`, so ambient globals such as `process` keep working with no
  action. For faster, more predictable builds, set an explicit list via `jsii.tsc.types` in `package.json` (e.g.
  `["node"]`).

#### If you provide your own `tsconfig.json`

When you provide your own `tsconfig.json`, jsii uses it verbatim and does not merge in the compiler options it would
otherwise generate for you, so TypeScript 6.0's new defaults apply directly. jsii also validates your config against the
rule set selected by `--validate-tsconfig` (`strict` by default), which now rejects the options TypeScript 6.0
deprecates. Make these changes both to satisfy TypeScript 6.0 and to pass validation:

- **Set `esModuleInterop: true`** (or remove the `false`) — TypeScript 6.0 errors on the deprecated value.
- **Set an explicit `types` array** (e.g. `["node", "jest"]`) — TypeScript 6.0 defaults `types` to `[]`, which
  otherwise drops ambient globals like `process` and test framework declarations.
- **Migrate deprecated options** — replace `baseUrl` with relative `paths` entries, and change `moduleResolution: node`
  (a.k.a. `node10`) to `node16`, `nodenext`, or `bundler`.
- **Remove any other deprecated options.** The `strict` and `generated` rule sets now reject everything TypeScript 6.0
  deprecates: `esModuleInterop: false`, `allowSyntheticDefaultImports: false`, `alwaysStrict: false`, `target: es5`,
  `module` values `amd`/`umd`/`systemjs`/`none`, `moduleResolution` values `node`/`node10`/`classic`,
  `downlevelIteration`, `outFile`, and `baseUrl`.

#### `jsii.tsc.baseUrl`

If you set `jsii.tsc.baseUrl` in `package.json`, move the prefix into your `jsii.tsc.paths` entries — it is no longer
read (`baseUrl` is deprecated in TypeScript 6.0).

### TypeScript 7.0

TypeScript 7.0 (the native port) is not yet supported. We are waiting on a finalized API proposal from the TypeScript
maintainers; until then, `jsii` will remain on TypeScript 6.0.

## :question: Documentation

Head over to our [documentation website](https://aws.github.io/jsii) for a comprehensive documentation for all things jsii!
The jsii toolchain is spread out on multiple repositories:

- [aws/jsii-compiler](https://github.com/aws/jsii-compiler) is where the `jsii` compiler is maintained
- [aws/jsii-rosetta](https://github.com/aws/jsii-rosetta) is where the `jsii-rosetta` sample code transliteration tool
  is maintained
- [aws/jsii](https://github.com/aws/jsii) is where the rest of the toolchain is maintained, including `jsii-pacmak` and language `runtimes`

### :book: Blog Posts

Here's a collection of blog posts (in chronological order) related to `jsii`:

- **2020-01-11:** [How to Create CDK Constructs][mbonig-2020-01-11], by [Matthew Bonig][@mbonig]
- **2020-05-27:** [Generate Python, Java, and .NET software libraries from a TypeScript source][floydpink-2020-05-27], by [Hari Pachuveetil][@floydpink]
- **2020-12-23:** [How the jsii open source framework meets developers where they are][romain-2020-12-23], by [Romain Marcadier][@RomainMuller]

[mbonig-2020-01-11]: https://www.matthewbonig.com/2020/01/11/creating-constructs/
[floydpink-2020-05-27]:
  https://aws.amazon.com/fr/blogs/opensource/generate-python-java-dotnet-software-libraries-from-typescript-source/
[romain-2020-12-23]:
  https://aws.amazon.com/blogs/opensource/how-the-jsii-open-source-framework-meets-developers-where-they-are/
[@mbonig]: http://www.matthewbonig.com/
[@floydpink]: https://harimenon.com/
[@romainmuller]: https://github.com/RomainMuller

> :information_source: If you wrote blog posts about `jsii` and would like to have them referenced here, do not hesitate
> to file a pull request to add the links here!

## :triangular_ruler: Inspecting & Validating tsconfig

When you provide your own `tsconfig.json` (via `--tsconfig`), `jsii` validates its `compilerOptions` against a
[rule set](#arrow_up-upgrading-to-jsii-60) (`strict` by default). Two commands let you inspect those rule sets and
validate a configuration file directly, without running a full compilation.

### `jsii rules`

Prints the validation rules for a rule set, so you can see exactly what each setting enforces:

```sh
# Print the rules for the strict rule set
jsii rules strict

# Print the rules for all rule sets (strict, generated, minimal, off)
jsii rules
```

The output lists, per `compilerOptions` field, whether it must be present and what values are allowed (or disallowed),
and whether unknown options are rejected for that rule set.

### `jsii validate-tsconfig`

Validates an existing TypeScript configuration file against a rule set and reports any violations. It exits with a
non-zero status when validation fails, which makes it suitable for use in CI or pre-commit checks:

```sh
# Validate ./tsconfig.json against the strict rule set (the default)
jsii validate-tsconfig

# Validate a specific file
jsii validate-tsconfig tsconfig.dev.json

# Validate against a different rule set (--rule-set, alias -R)
jsii validate-tsconfig tsconfig.json --rule-set generated
jsii validate-tsconfig tsconfig.json -R minimal
```

The available rule sets are `strict`, `generated`, `minimal`, and `off`. They behave exactly as the `--validate-tsconfig`
option does during compilation; see [Upgrading to jsii 6.0](#arrow_up-upgrading-to-jsii-60) for guidance on the rules
each set enforces.

## :mute: Silencing Warnings

The `--silence-warnings` option allows you to suppress specific warnings from the compiler output. Silenced warnings
are still emitted internally (e.g. they are still part of the assembly), but are not printed to the console. When
`--fail-on-warnings` (`--Werr`) is set, silenced warnings are not treated as errors.

Warnings can be identified by JSII code, number, or diagnostic name:

```sh
# By full JSII code
jsii --silence-warnings JSII5018

# By number only
jsii --silence-warnings 5018

# By specific diagnostic name (the part after the slash)
jsii --silence-warnings reserved-word

# By full diagnostic name
jsii --silence-warnings language-compatibility/reserved-word

# By category (silences ALL warnings in that category)
jsii --silence-warnings language-compatibility

# Multiple warnings
jsii --silence-warnings reserved-word JSII5019
```

### Inline Suppression

Individual warnings can be suppressed directly in source code using the `@jsii suppress` directive. This is useful
when you want `--fail-on-warnings` enabled globally but need to allow specific instances of a warning.

Each directive accepts a single warning identifier using the same formats as `--silence-warnings`. An optional text after
the identifier is treated as an explanation comment. Use multiple directives to suppress multiple warnings:

```ts
export class MyClass {
  /**
   * @jsii suppress JSII5019 this name is intentional
   * @jsii suppress reserved-word
   */
  public myClass(): void { }
}
```

The suppression applies to the annotated declaration and all of its members. For example, a `@jsii suppress`
directive on a class will suppress matching warnings on all methods and properties within that class.

Only warnings that reference a source code location can be suppressed inline. Warnings not tied to a specific node
(e.g. `JSII0003` for a missing README) are not affected.

## :balance_scale: License

**jsii** is distributed under the [Apache License, Version 2.0][apache-2.0].

See [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for more information.

[apache-2.0]: https://www.apache.org/licenses/LICENSE-2.0

## :gear: Contributing

See [CONTRIBUTING](./CONTRIBUTING.md).
