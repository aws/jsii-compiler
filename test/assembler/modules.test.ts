import { compileJsiiForTest } from '../../src/helpers';

const typeNames = (files: { 'index.ts': string; [file: string]: string }) =>
  Object.keys(compileJsiiForTest(files).assembly.types ?? {}).sort();

describe('re-exports', () => {
  test('"export * from" exposes the types of the other file', () => {
    expect(
      typeNames({
        'index.ts': "export * from './other';\nexport class Local {}",
        'other.ts': 'export class Other {}\nexport enum Mode { A }',
      }),
    ).toEqual(['testpkg.Local', 'testpkg.Mode', 'testpkg.Other']);
  });

  test('"export { Name } from" only exposes the types that are named', () => {
    expect(
      typeNames({
        'index.ts': "export { Named } from './other';",
        'other.ts': 'export class Named {}\nexport class NotNamed {}',
      }),
    ).toEqual(['testpkg.Named']);
  });

  test('a type that is exported from a file, but not from the entry point, is not part of the assembly', () => {
    expect(
      typeNames({
        'index.ts': 'export class Visible {}',
        'other.ts': 'export class Invisible {}',
      }),
    ).toEqual(['testpkg.Visible']);
  });

  test('an exported type can be used by the types of another file', () => {
    const { assembly } = compileJsiiForTest({
      'index.ts': "export * from './a';\nexport * from './b';",
      'a.ts': 'export class A {}',
      'b.ts': "import { A } from './a';\nexport class B { public a(): A { return new A(); } }",
    });

    expect((assembly.types!['testpkg.B'] as any).methods[0].returns).toEqual({ type: { fqn: 'testpkg.A' } });
  });

  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/3033
  // The type should be named after its export (`testpkg.Z`), or the rename should be reported.
  test('a type that is exported under another name keeps the name of its declaration', () => {
    expect(
      typeNames({
        'index.ts': "export { X as Z } from './other';",
        'other.ts': 'export class X {}',
      }),
    ).toEqual(['testpkg.X']);
  });
});

describe('namespaces', () => {
  test('a type in a namespace is named after the namespace and the type', () => {
    expect(typeNames({ 'index.ts': 'export namespace Outer { export class Inner {} }' })).toEqual([
      'testpkg.Outer.Inner',
    ]);
  });

  test('a class can be merged with a namespace', () => {
    expect(
      typeNames({
        'index.ts':
          'export class Klass {}\nexport namespace Klass { export interface Options { readonly a?: string } }',
      }),
    ).toEqual(['testpkg.Klass', 'testpkg.Klass.Options']);
  });
});

describe('submodules', () => {
  test('"export * as" makes a submodule, and its types are named after it', () => {
    const { assembly } = compileJsiiForTest({
      'index.ts': "export * as sub from './sub';",
      'sub.ts': 'export class Foo {}',
    });

    expect(Object.keys(assembly.submodules!)).toEqual(['testpkg.sub']);
    expect(Object.keys(assembly.types!)).toEqual(['testpkg.sub.Foo']);
    expect(assembly.types!['testpkg.sub.Foo']).toMatchObject({ namespace: 'sub', name: 'Foo' });
  });

  test('submodules can be nested', () => {
    const { assembly } = compileJsiiForTest({
      'index.ts': "export * as outer from './outer';",
      'outer/index.ts': "export * as inner from './inner';",
      'outer/inner/index.ts': 'export class Foo {}',
    });

    expect(Object.keys(assembly.submodules!).sort()).toEqual(['testpkg.outer', 'testpkg.outer.inner']);
    expect(Object.keys(assembly.types!)).toEqual(['testpkg.outer.inner.Foo']);
  });

  test('the types of a submodule are not part of the root of the package', () => {
    const { assembly } = compileJsiiForTest({
      'index.ts': "export * as sub from './sub';\nexport class Root {}",
      'sub.ts': 'export class Foo {}',
    });

    expect(assembly.types!['testpkg.Root']).toBeDefined();
    expect(assembly.types!['testpkg.Foo']).toBeUndefined();
  });
});

describe('README.md', () => {
  test('is the readme of the assembly', () => {
    const { assembly } = compileJsiiForTest({ 'index.ts': 'export class Klass {}', 'README.md': '# My library' });

    expect(assembly.readme).toEqual({ markdown: '# My library' });
  });

  test('is absent when there is none', () => {
    const { assembly } = compileJsiiForTest({ 'index.ts': 'export class Klass {}' });

    expect(assembly.readme).toBeUndefined();
  });
});
