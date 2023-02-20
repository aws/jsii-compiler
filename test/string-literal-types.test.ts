import { sourceToAssemblyHelper } from '../lib';

// ----------------------------------------------------------------------
test('test parsing string literal type with enum interpolation', () => {
  const assembly = sourceToAssemblyHelper(`
    export enum Foo {
      BAR,
      BAZ,
    }

    export interface UsesSTT {
      readonly foo: \`foo - \${Foo}\`
    }
  `);

  expect(assembly.types!['testpkg.UsesSTT']).toEqual({
    assembly: 'testpkg',
    datatype: true,
    fqn: 'testpkg.UsesSTT',
    kind: 'interface',
    properties: [
      {
        abstract: true,
        immutable: true,
        locationInModule: {
          filename: 'index.ts',
          line: 8,
        },
        name: 'foo',
        type: {
          primitive: 'string',
        },
      },
    ],
    locationInModule: { filename: 'index.ts', line: 7 },
    name: 'UsesSTT',
    symbolId: 'index:UsesSTT',
  });
});

// ----------------------------------------------------------------------
test('test parsing string literal type with number interpolation', () => {
  const assembly = sourceToAssemblyHelper(`
    export interface UsesSTT {
      readonly foo: \`foo - \${number}\`
    }
  `);

  expect(assembly.types!['testpkg.UsesSTT']).toEqual({
    assembly: 'testpkg',
    datatype: true,
    fqn: 'testpkg.UsesSTT',
    kind: 'interface',
    properties: [
      {
        abstract: true,
        immutable: true,
        locationInModule: {
          filename: 'index.ts',
          line: 3,
        },
        name: 'foo',
        type: {
          primitive: 'string',
        },
      },
    ],
    locationInModule: { filename: 'index.ts', line: 2 },
    name: 'UsesSTT',
    symbolId: 'index:UsesSTT',
  });
});
