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
  
test('Abstract member can have a promise return type', () => {
    const assembly = sourceToAssemblyHelper(`
    export abstract class AbstractClass {
        public abstract abstractMethod(): Promise<void>;
    }
  `);

    expect(assembly.types!['testpkg.AbstractClass']).toEqual({
        assembly: 'testpkg',
        fqn: 'testpkg.AbstractClass',
        kind: 'class',
        abstract: true,
        initializer: {},
        methods: [
            {
                async: true,
                locationInModule: { filename: 'index.ts', line: 3 },
                name: 'abstractMethod',
                abstract: true,
            },
        ],
        locationInModule: { filename: 'index.ts', line: 2 },
        name: 'AbstractClass',
        symbolId: 'index:AbstractClass',
    });
});