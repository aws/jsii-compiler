import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Assembly } from '@jsii/spec';
import { compileJsiiForTest, normalizePath, symbolIdentifier, SymbolIdChecker, SymbolIdSymbol } from '../lib';

test('Symbol map is generated', () => {
  const result = compileJsiiForTest(
    {
      'index.ts': `
        export * from './some/nested/file';
        export class Foo {
          public bar(){}
        }
      `,
      'some/nested/file.ts': `
        export interface Bar {
          readonly x: string;
        }
        export enum Baz {
          ALPHA = 0,
          BETA = 1,
        }
        `,
    },
    undefined /* callback */,
    { stripDeprecated: true },
  );

  const types = result.assembly.types ?? {};
  expect(types['testpkg.Foo'].symbolId).toEqual('index:Foo');
  expect(types['testpkg.Bar'].symbolId).toEqual('some/nested/file:Bar');
  expect(types['testpkg.Baz'].symbolId).toEqual('some/nested/file:Baz');
});

test('Symbol id for single-value enum correctly identifies enum', () => {
  const result = compileJsiiForTest(
    {
      'index.ts': `
        export enum SomeEnum {
          SINGLETON_VALUE = 'value',
        }
      `,
    },
    undefined /* callback */,
    { stripDeprecated: true },
  );

  const types = result.assembly.types ?? {};
  expect(types['testpkg.SomeEnum'].symbolId).toEqual('index:SomeEnum');
});

test('Module declarations are included in symbolId', () => {
  const result = compileJsiiForTest(
    {
      'index.ts': `
        export class Foo {
          constructor() {
          }
        }
        export namespace Foo {
          export class Bar {
            public baz() {}
          }
        }
      `,
    },
    undefined /* callback */,
    { stripDeprecated: true },
  );

  const types = result.assembly.types ?? {};
  expect(types['testpkg.Foo.Bar'].symbolId).toEqual('index:Foo.Bar');
});

test('Submodules also have symbol identifiers', () => {
  const result = compileJsiiForTest(
    {
      'index.ts': "export * as submod from './submodule';",
      'submodule.ts': `
        export class Foo {
          constructor() {
          }
        }
      `,
    },
    undefined /* callback */,
    { stripDeprecated: true },
  );

  expect(result.assembly.submodules?.['testpkg.submod']?.symbolId).toEqual('submodule:');
});

test('Submodules also have symbol identifiers', () => {
  const result = compileJsiiForTest(
    {
      'index.ts': `
        export namespace cookie {
          export class Foo {
            constructor() {
            }
          }
        }
      `,
    },
    undefined /* callback */,
    { stripDeprecated: true },
  );

  expect(result.assembly.submodules?.['testpkg.cookie']?.symbolId).toEqual('index:cookie');
});

describe(normalizePath, () => {
  test('basic rootDir and outDir', () => {
    expect(normalizePath('out/filename.ts', 'root', 'out')).toEqual('root/filename.ts');
    expect(normalizePath('out/filename.ts', undefined, 'out')).toEqual('out/filename.ts');
    expect(normalizePath('out/filename.ts', 'root', undefined)).toEqual('out/filename.ts');
    expect(normalizePath('out/filename.ts', undefined, undefined)).toEqual('out/filename.ts');
  });

  test('extra slashes in directories', () => {
    expect(normalizePath('out/filename.ts', 'root/', 'out/')).toEqual('root/filename.ts');
    expect(normalizePath('out/filename.ts', 'root////', 'out////')).toEqual('root/filename.ts');
    expect(normalizePath('out/lib/filename.ts', 'root///', 'out//lib//')).toEqual('root/filename.ts');
  });

  test('additional paths in directories', () => {
    expect(normalizePath('out/filename.ts', './root', 'out')).toEqual('root/filename.ts');
    expect(normalizePath('out/filename.ts', 'root', './out')).toEqual('root/filename.ts');
    expect(normalizePath('out/filename.ts', 'root', './here/../out')).toEqual('root/filename.ts');
    expect(normalizePath('out/filename.ts', 'root/../root/..', '.')).toEqual('out/filename.ts');
  });

  test('empty paths', () => {
    expect(normalizePath('out/lib/filename.ts', '', 'out')).toEqual('lib/filename.ts');
    expect(normalizePath('out/lib/filename.ts', '.', 'out')).toEqual('lib/filename.ts');
    expect(normalizePath('lib/filename.ts', 'root', '')).toEqual('root/lib/filename.ts');
    expect(normalizePath('lib/filename.ts', 'root', '.')).toEqual('root/lib/filename.ts');
    expect(normalizePath('lib/filename.ts', '', '')).toEqual('lib/filename.ts');
    expect(normalizePath('lib/filename.ts', '.', '.')).toEqual('lib/filename.ts');
  });

  test('specify multiple directories', () => {
    expect(normalizePath('out/lib/filename.ts', 'root', 'out/lib')).toEqual('root/filename.ts');
    expect(normalizePath('out/lib/filename.ts', 'root/extra', 'out')).toEqual('root/extra/lib/filename.ts');
    expect(normalizePath('out/lib/filename.ts', '.', 'out/lib')).toEqual('filename.ts');
    expect(normalizePath('lib/filename.ts', 'root/extra', '.')).toEqual('root/extra/lib/filename.ts');
  });
});

describe('symbolId resolution for consumed packages (https://github.com/aws/jsii-compiler/issues/2740)', () => {
  // Simulates resolving a symbolId against an installed (compiled) package:
  // only the `.d.ts` files and `package.json` are available, and the symbol
  // id must be re-rooted from the outDir (`lib/`) into the rootDir (`src/`)
  // to match the `symbolId` values recorded in the assembly.
  //
  // `symbolIdentifier` only needs `getAliasedSymbol` / `getFullyQualifiedName`
  // and the symbol flags, so the checker is modelled structurally here: this is
  // the same contract both the classic `ts.TypeChecker` (jsii-rosetta) and the
  // TypeScript 7 checker fulfil.
  let packageDir: string;

  beforeEach(() => {
    packageDir = mkdtempSync(join(tmpdir(), 'jsii-symbolid-'));
    mkdirSync(join(packageDir, 'lib'), { recursive: true });
    writeFileSync(join(packageDir, 'lib', 'index.d.ts'), 'export declare class Foo {}\n');
  });

  afterEach(() => {
    rmSync(packageDir, { force: true, recursive: true });
  });

  interface FakeSymbol extends SymbolIdSymbol {
    readonly qualifiedName: string;
    readonly target?: FakeSymbol;
  }

  const checker: SymbolIdChecker<FakeSymbol> = {
    getAliasedSymbol: (sym) => sym.target ?? sym,
    getFullyQualifiedName: (sym) => sym.qualifiedName,
  };

  function computeSymbolId(packageJson: object, assembly: Assembly, sym?: FakeSymbol): string | undefined {
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify(packageJson, null, 2));
    const foo: FakeSymbol = { flags: 32 /* Class */, qualifiedName: `"${join(packageDir, 'lib', 'index')}".Foo` };
    return symbolIdentifier(checker, sym ?? foo, { assembly });
  }

  test('outDir is read from jsii.tsc in package.json when present', () => {
    const symbolId = computeSymbolId({ name: 'testpkg', jsii: { tsc: { rootDir: 'src', outDir: 'lib' } } }, {
      metadata: {},
    } as unknown as Assembly);

    expect(symbolId).toEqual('src/index:Foo');
  });

  test('falls back to assembly metadata when package.json has no jsii.tsc (jsii.tsconfig packages)', () => {
    // A package built with a user-provided tsconfig (`jsii.tsconfig`) has no
    // `jsii.tsc` in its package.json, and its tsconfig.json is typically not
    // published. The outDir/rootDir must be recoverable from the assembly.
    const symbolId = computeSymbolId({ name: 'testpkg', jsii: {} }, {
      metadata: { tscRootDir: 'src', tscOutDir: 'lib' },
    } as unknown as Assembly);

    expect(symbolId).toEqual('src/index:Foo');
  });

  test('aliases are resolved and members use the # separator', () => {
    const target: FakeSymbol = { flags: 8192 /* Method */, qualifiedName: `"${join(packageDir, 'lib', 'index')}".Foo.bar` };
    const alias: FakeSymbol = { flags: 2097152 /* Alias */, qualifiedName: 'unused', target };
    const symbolId = computeSymbolId({ name: 'testpkg', jsii: {} }, { metadata: {} } as unknown as Assembly, alias);

    expect(symbolId).toEqual('lib/index:Foo#bar');
  });
});
