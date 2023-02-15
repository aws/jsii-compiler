import { PrimitiveType, Type, TypeKind } from '@jsii/spec';
import { sourceToAssemblyHelper } from '../lib';

// ----------------------------------------------------------------------
test('Abstract member cant be marked async', () => {
  expect(() =>
    sourceToAssemblyHelper(`
      export abstract class AbstractClass {
        public abstract async abstractMethod(): Promise<void>;
    }
    `),
  ).toThrow(/There were compiler errors/);
});

test('Abstract member can have a Promise<void> return type', () => {
  const assembly = sourceToAssemblyHelper(`
    export abstract class AbstractClass {
        public abstract abstractMethod(): Promise<void>;
    }
  `);

  expect(assembly.types!['testpkg.AbstractClass']).toEqual({
    assembly: 'testpkg',
    fqn: 'testpkg.AbstractClass',
    kind: TypeKind.Class,
    abstract: true,
    initializer: {},
    methods: [
      {
        abstract: true,
        async: true,
        locationInModule: { filename: 'index.ts', line: 3 },
        name: 'abstractMethod',
      },
    ],
    locationInModule: { filename: 'index.ts', line: 2 },
    name: 'AbstractClass',
    symbolId: 'index:AbstractClass',
  } satisfies Type);
});

test('Abstract member can have a Promise<String> return type', () => {
  const assembly = sourceToAssemblyHelper(`
    export abstract class AbstractClass {
        public abstract abstractMethod(): Promise<String>;
    }
  `);

  expect(assembly.types!['testpkg.AbstractClass']).toEqual({
    assembly: 'testpkg',
    fqn: 'testpkg.AbstractClass',
    kind: TypeKind.Class,
    abstract: true,
    initializer: {},
    methods: [
      {
        abstract: true,
        async: true,
        locationInModule: { filename: 'index.ts', line: 3 },
        name: 'abstractMethod',
        returns: { type: { primitive: PrimitiveType.String } },
      },
    ],
    locationInModule: { filename: 'index.ts', line: 2 },
    name: 'AbstractClass',
    symbolId: 'index:AbstractClass',
  } satisfies Type);
});
