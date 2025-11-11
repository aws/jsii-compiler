import * as spec from '@jsii/spec';
import { writeAssembly, loadAssemblyFromPath } from '@jsii/spec';
import * as ts from 'typescript';

import { sourceToAssemblyHelper, TestWorkspace, compileJsiiForTest } from '../lib';
import { compileJsiiForErrors } from './compiler-helpers';

test('submodules loaded from directories can have a README', () => {
  const assembly = sourceToAssemblyHelper({
    'index.ts': 'export * as submodule from "./subdir"',
    'subdir/index.ts': 'export class Foo { }',
    'subdir/README.md': 'This is the README',
  });

  expect(assembly.submodules!['testpkg.submodule']).toEqual(
    expect.objectContaining({
      readme: {
        markdown: 'This is the README',
      },
    }),
  );
});

test('submodules loaded from files can have a README', () => {
  const assembly = sourceToAssemblyHelper({
    'index.ts': 'export * as submodule from "./submod"',
    'submod.ts': 'export class Foo { }',
    'submod.README.md': 'This is the README',
  });

  expect(assembly.submodules!['testpkg.submodule']).toEqual(
    expect.objectContaining({
      readme: {
        markdown: 'This is the README',
      },
    }),
  );
});

test('submodules loaded from directories can have targets', () => {
  const assembly = sourceToAssemblyHelper({
    'index.ts': 'export * as submodule from "./subdir"',
    'subdir/index.ts': 'export class Foo { }',
    'subdir/.jsiirc.json': JSON.stringify({
      targets: {
        python: { module: 'fun', distName: 'fun-dist' },
      },
    }),
  });

  expect(assembly.submodules!['testpkg.submodule']).toEqual(
    expect.objectContaining({
      targets: {
        python: { module: 'fun', distName: 'fun-dist' },
      },
    }),
  );
});

test('submodules loaded from files can have targets', () => {
  const assembly = sourceToAssemblyHelper({
    'index.ts': 'export * as submodule from "./subfile"',
    'subfile.ts': 'export class Foo { }',
    '.subfile.jsiirc.json': JSON.stringify({
      targets: {
        python: { module: 'fun', distName: 'fun-dist' },
      },
    }),
  });

  expect(assembly.submodules!['testpkg.submodule']).toEqual(
    expect.objectContaining({
      targets: {
        python: { module: 'fun', distName: 'fun-dist' },
      },
    }),
  );
});

test('submodule READMEs can have literate source references', () => {
  const assembly = sourceToAssemblyHelper({
    'index.ts': 'export * as submodule from "./subdir"',
    'subdir/index.ts': 'export class Foo { }',
    'subdir/README.md': 'This is the README\n\n[includable](./test/includeme.lit.ts)',
    'subdir/test/includeme.lit.ts': '// Include me',
  });

  expect(assembly.submodules!['testpkg.submodule']).toEqual(
    expect.objectContaining({
      readme: {
        markdown: ['This is the README', '', '```ts lit=subdir/test/includeme.lit.ts', '// Include me', '```'].join(
          '\n',
        ),
      },
    }),
  );
});

type ImportStyle = 'directly' | 'as namespace' | 'with alias';

test.each(['directly', 'as namespace', 'with alias'] as ImportStyle[])(
  'can reference submodule types, importing %s',
  (importStyle) =>
    TestWorkspace.withWorkspace((ws) => {
      // There are 2 import styles:
      //
      // import { submodule } from 'lib';
      // import * as submodule from 'lib/submodule';
      //
      // We need to support both import styles.

      // Dependency that exports a submodule
      ws.addDependency(makeDependencyWithSubmodule());

      let importStatement;
      let prefix;
      switch (importStyle) {
        case 'directly':
          importStatement = "import { Foo, FooInterface, IProtocol } from 'testpkg/subdir'";
          prefix = '';
          break;
        case 'as namespace':
          importStatement = "import { submodule } from 'testpkg'";
          prefix = 'submodule.';
          break;
        case 'with alias':
          importStatement = "import { submodule as sub } from 'testpkg'";
          prefix = 'sub.';
          break;
      }

      // Main library that imports the submodule class directly
      // Use the type in all possible positions
      const result = compileJsiiForTest(
        {
          'index.ts': `
        ${importStatement};

        export interface BarProps {
          readonly foo?: ${prefix}Foo;
        }

        export class Bar {
          constructor(public readonly foo: ${prefix}Foo, props: BarProps = {}) {
            Array.isArray(props);
          }

          public returnValue(): ${prefix}Foo {
            return new ${prefix}Foo();
          }
        }

        export class SubFoo extends ${prefix}Foo {}
        export interface SubInterface extends ${prefix}FooInterface {}
        export class Implementor implements ${prefix}IProtocol {}
      `,
        },
        {
          packageJson: {
            // Must be a different name from the dependency
            name: 'consumerpkg',
            peerDependencies: { testpkg: '*' },
          },
          compilationDirectory: ws.rootDirectory,
        },
      );

      expect((result.assembly.types?.['consumerpkg.Bar'] as spec.ClassType)?.initializer?.parameters).toEqual([
        {
          name: 'foo',
          type: { fqn: 'testpkg.submodule.Foo' },
        },
        {
          name: 'props',
          optional: true,
          type: { fqn: 'consumerpkg.BarProps' },
        },
      ]);
    }),
);

test.each(['directly', 'as namespace', 'with alias'] as ImportStyle[])(
  'can reference nested types in submodules, importing %s',
  (importStyle) =>
    TestWorkspace.withWorkspace((ws) => {
      // There are 2 import styles:
      //
      // import { submodule } from 'lib';
      // import * as submodule from 'lib/submodule';
      //
      // We need to support both import styles.

      // Dependency that exports a submodule
      ws.addDependency(makeDependencyWithSubmoduleAndNamespace());

      let importStatement;
      let prefix;
      switch (importStyle) {
        case 'directly':
          importStatement = "import { Namespace } from 'testpkg/subdir'";
          prefix = 'Namespace.';
          break;
        case 'as namespace':
          importStatement = "import { submodule } from 'testpkg'";
          prefix = 'submodule.Namespace.';
          break;
        case 'with alias':
          importStatement = "import { submodule as sub } from 'testpkg'";
          prefix = 'sub.Namespace.';
          break;
      }

      // Main library that imports the submodule class directly
      // Use the type in all possible positions
      const result = compileJsiiForTest(
        {
          'index.ts': `
        ${importStatement};

        export interface BarProps {
          readonly foo?: ${prefix}Foo;
        }

        export class Bar {
          constructor(public readonly foo: ${prefix}Foo, props: BarProps = {}) {
            Array.isArray(props);
          }

          public returnValue(): ${prefix}Foo {
            return new ${prefix}Foo();
          }
        }

        export class SubFoo extends ${prefix}Foo {}
        export interface SubInterface extends ${prefix}FooInterface {}
        export class Implementor implements ${prefix}IProtocol {}
      `,
        },
        {
          packageJson: {
            // Must be a different name from the dependency
            name: 'consumerpkg',
            peerDependencies: { testpkg: '*' },
          },
          compilationDirectory: ws.rootDirectory,
        },
      );

      expect((result.assembly.types?.['consumerpkg.Bar'] as spec.ClassType)?.initializer?.parameters).toEqual([
        {
          name: 'foo',
          type: { fqn: 'testpkg.submodule.Namespace.Foo' },
        },
        {
          name: 'props',
          optional: true,
          type: { fqn: 'consumerpkg.BarProps' },
        },
      ]);
    }),
);

// Backwards compatibility test, for versions of libraries compiled before jsii 1.39.0
// which introduced the symbol identifier table
test('will detect types from submodules even if the symbol identifier table is missing', () =>
  TestWorkspace.withWorkspace((ws) => {
    ws.addDependency(makeDependencyWithSubmodule());

    // Strip the symbolidentifiers from the assembly
    const asmDir = ws.dependencyDir('testpkg');
    const asm: spec.Assembly = loadAssemblyFromPath(asmDir, false);
    for (const mod of Object.values(asm.submodules ?? {})) {
      delete mod.symbolId;
    }
    for (const type of Object.values(asm.types ?? {})) {
      delete type.symbolId;
    }
    writeAssembly(asmDir, asm);

    // We can still use those types if we have a full-library import
    compileJsiiForTest(
      {
        'index.ts': `
          import { submodule } from 'testpkg';
          export class Bar {
            constructor(public readonly foo: submodule.Foo) {}
          }
      `,
      },
      {
        packageJson: {
          // Must be a different name from the dependency
          name: 'consumerpkg',
          peerDependencies: { testpkg: '*' },
        },
        compilationDirectory: ws.rootDirectory,
      },
    );
  }));

function makeDependencyWithSubmodule() {
  return compileJsiiForTest({
    'index.ts': 'export * as submodule from "./subdir"',
    'subdir/index.ts': [
      'export class Foo { };',
      'export interface FooInterface { readonly value?: string }',
      'export interface IProtocol { readonly value?: string; }',
    ].join('\n'),
    'subdir/README.md': 'This is the README',
  });
}

function makeDependencyWithSubmoduleAndNamespace() {
  return compileJsiiForTest({
    'index.ts': 'export * as submodule from "./subdir"',
    'subdir/index.ts': [
      'export class Namespace {};',
      'export namespace Namespace {',
      '  export class Foo { };',
      '  export interface FooInterface { readonly value?: string }',
      '  export interface IProtocol { readonly value?: string; }',
      '}',
    ].join('\n'),
    'subdir/README.md': 'This is the README',
  });
}

describe('invalid .jsiirc.json target configuration', () => {
  test('invalid Go packageName is rejected', () => {
    const errors = compileJsiiForErrors({
      'index.ts': 'export * as submodule from "./subdir"',
      'subdir/index.ts': 'export class Foo { }',
      'subdir/.jsiirc.json': JSON.stringify({
        targets: {
          go: {
            moduleName: 'asdf',
            packageName: 'as-df',
          },
        },
      }),
    });
    expect(errors).toContainEqual(
      expect.stringMatching(/jsii\.targets\.go\.packageName contains non-identifier characters/),
    );
  });

  test('invalid .NET namespace is rejected', () => {
    const errors = compileJsiiForErrors({
      'index.ts': 'export * as submodule from "./subdir"',
      'subdir/index.ts': 'export class Foo { }',
      'subdir/.jsiirc.json': JSON.stringify({
        targets: {
          dotnet: {
            namespace: 'a-x',
            packageId: 'asdf',
          },
        },
      }),
    });
    expect(errors).toContainEqual(
      expect.stringMatching(/jsii\.targets\.dotnet\.namespace contains non-identifier characters/),
    );
  });

  test('invalid Java package is rejected', () => {
    const errors = compileJsiiForErrors({
      'index.ts': 'export * as submodule from "./subdir"',
      'subdir/index.ts': 'export class Foo { }',
      'subdir/.jsiirc.json': JSON.stringify({
        targets: {
          java: {
            package: 'as-df',
            maven: {
              artifactId: 'asdf',
              groupId: 'asdf',
            },
          },
        },
      }),
    });
    expect(errors).toContainEqual(
      expect.stringMatching(/jsii\.targets\.java\.package contains non-identifier characters/),
    );
  });

  test('invalid Python module is rejected', () => {
    const errors = compileJsiiForErrors({
      'index.ts': 'export * as submodule from "./subdir"',
      'subdir/index.ts': 'export class Foo { }',
      'subdir/.jsiirc.json': JSON.stringify({
        targets: {
          python: {
            module: 'as-df',
            distName: 'as-df',
          },
        },
      }),
    });
    expect(errors).toContainEqual(
      expect.stringMatching(/jsii\.targets\.python\.module contains non-identifier characters/),
    );
  });

  test('invalid Python module in file-based config is rejected', () => {
    const errors = compileJsiiForErrors({
      'index.ts': 'export * as submodule from "./subfile"',
      'subfile.ts': 'export class Foo { }',
      '.subfile.jsiirc.json': JSON.stringify({
        targets: {
          python: {
            module: 'invalid-name',
            distName: 'dist',
          },
        },
      }),
    });
    expect(errors).toContainEqual(
      expect.stringMatching(/jsii\.targets\.python\.module contains non-identifier characters/),
    );
  });

  test('non-object target language config is rejected', () => {
    const errors = compileJsiiForErrors({
      'index.ts': 'export * as submodule from "./subfile"',
      'subfile.ts': 'export class Foo { }',
      '.subfile.jsiirc.json': JSON.stringify({
        targets: {
          python: 'not-an-object',
        },
      }),
    });
    expect(errors).toContainEqual(expect.stringMatching(/jsii\.targets\.python must be an object/));
  });

  test('unknown target language is rejected', () => {
    const errors = compileJsiiForErrors({
      'index.ts': 'export * as submodule from "./subfile"',
      'subfile.ts': 'export class Foo { }',
      '.subfile.jsiirc.json': JSON.stringify({
        targets: {
          rust: { package: 'my-crate' },
        },
      }),
    });
    expect(errors).toContainEqual(expect.stringMatching(/Unknown target language: rust/));
  });

  test('unknown key in target config is rejected', () => {
    const errors = compileJsiiForErrors({
      'index.ts': 'export * as submodule from "./subfile"',
      'subfile.ts': 'export class Foo { }',
      '.subfile.jsiirc.json': JSON.stringify({
        targets: {
          python: {
            module: 'valid_module',
            distName: 'dist',
            unknownKey: 'value',
          },
        },
      }),
    });
    expect(errors).toContainEqual(expect.stringMatching(/Unknown key in jsii\.targets\.python: unknownKey/));
  });
});

describe('submodule namespace conflicts', () => {
  test('conflicting .NET namespaces produce warnings', () => {
    const result = compileJsiiForTest(
      {
        'index.ts': 'export * as sub1 from "./sub1"; export * as sub2 from "./sub2"',
        'sub1.ts': 'export class Foo { }',
        'sub2.ts': 'export class Bar { }',
        '.sub1.jsiirc.json': JSON.stringify({
          targets: { dotnet: { namespace: 'Same.Namespace', packageId: 'pkg1' } },
        }),
        '.sub2.jsiirc.json': JSON.stringify({
          targets: { dotnet: { namespace: 'Same.Namespace', packageId: 'pkg2' } },
        }),
      },
      { captureDiagnostics: true },
    );
    const warnings = result.diagnostics
      .filter((d) => d.category === ts.DiagnosticCategory.Warning)
      .map((d) => `${d.messageText}`);
    expect(warnings).toContainEqual(expect.stringMatching(/dotnet.*Same\.Namespace.*testpkg\.sub1.*testpkg\.sub2/));
  });

  test('conflicting Java packages produce warnings', () => {
    const result = compileJsiiForTest(
      {
        'index.ts': 'export * as sub1 from "./sub1"; export * as sub2 from "./sub2"',
        'sub1.ts': 'export class Foo { }',
        'sub2.ts': 'export class Bar { }',
        '.sub1.jsiirc.json': JSON.stringify({
          targets: { java: { package: 'same.pkg', maven: { artifactId: 'a', groupId: 'g' } } },
        }),
        '.sub2.jsiirc.json': JSON.stringify({
          targets: { java: { package: 'same.pkg', maven: { artifactId: 'b', groupId: 'g' } } },
        }),
      },
      { captureDiagnostics: true },
    );
    const warnings = result.diagnostics
      .filter((d) => d.category === ts.DiagnosticCategory.Warning)
      .map((d) => `${d.messageText}`);
    expect(warnings).toContainEqual(expect.stringMatching(/java.*same\.pkg.*testpkg\.sub1.*testpkg\.sub2/));
  });

  test('conflicting Python modules produce warnings', () => {
    const result = compileJsiiForTest(
      {
        'index.ts': 'export * as sub1 from "./sub1"; export * as sub2 from "./sub2"',
        'sub1.ts': 'export class Foo { }',
        'sub2.ts': 'export class Bar { }',
        '.sub1.jsiirc.json': JSON.stringify({ targets: { python: { module: 'same_module', distName: 'dist1' } } }),
        '.sub2.jsiirc.json': JSON.stringify({ targets: { python: { module: 'same_module', distName: 'dist2' } } }),
      },
      { captureDiagnostics: true },
    );
    const warnings = result.diagnostics
      .filter((d) => d.category === ts.DiagnosticCategory.Warning)
      .map((d) => `${d.messageText}`);
    expect(warnings).toContainEqual(expect.stringMatching(/python.*same_module.*testpkg\.sub1.*testpkg\.sub2/));
  });

  test('conflicting Go packages produce warnings', () => {
    const result = compileJsiiForTest(
      {
        'index.ts': 'export * as sub1 from "./sub1"; export * as sub2 from "./sub2"',
        'sub1.ts': 'export class Foo { }',
        'sub2.ts': 'export class Bar { }',
        '.sub1.jsiirc.json': JSON.stringify({ targets: { go: { moduleName: 'mod1', packageName: 'samepkg' } } }),
        '.sub2.jsiirc.json': JSON.stringify({ targets: { go: { moduleName: 'mod2', packageName: 'samepkg' } } }),
      },
      { captureDiagnostics: true },
    );
    const warnings = result.diagnostics
      .filter((d) => d.category === ts.DiagnosticCategory.Warning)
      .map((d) => `${d.messageText}`);
    expect(warnings).toContainEqual(expect.stringMatching(/go.*samepkg.*testpkg\.sub1.*testpkg\.sub2/));
  });

  test('directory and file submodules with different configs do not conflict', () => {
    const assembly = sourceToAssemblyHelper({
      'index.ts': 'export * as sub1 from "./subdir"; export * as sub2 from "./sub2"',
      'subdir/index.ts': 'export class Foo { }',
      'sub2.ts': 'export class Bar { }',
      'subdir/.jsiirc.json': JSON.stringify({ targets: { python: { module: 'dir_module', distName: 'dir-dist' } } }),
      '.sub2.jsiirc.json': JSON.stringify({ targets: { python: { module: 'file_module', distName: 'file-dist' } } }),
    });
    expect(assembly.submodules!['testpkg.sub1'].targets).toEqual({ python: { module: 'dir_module', distName: 'dir-dist' } });
    expect(assembly.submodules!['testpkg.sub2'].targets).toEqual({ python: { module: 'file_module', distName: 'file-dist' } });
  });
});
