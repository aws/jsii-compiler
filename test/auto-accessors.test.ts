import { PrimitiveType, Type, TypeKind } from '@jsii/spec';
import { sourceToAssemblyHelper } from '../lib';

// ----------------------------------------------------------------------
test('auto accessors', () => {
  const assembly = sourceToAssemblyHelper(`
    export class Automatic {
      public accessor property: boolean = true;

      private constructor(){}
    }
  `);

  expect(assembly.types!['testpkg.Automatic']).toEqual({
    assembly: 'testpkg',
    fqn: 'testpkg.Automatic',
    kind: TypeKind.Class,
    properties: [
      {
        locationInModule: {
          filename: 'index.ts',
          line: 3,
        },
        name: 'property',
        type: {
          primitive: PrimitiveType.Boolean,
        },
      },
    ],
    locationInModule: { filename: 'index.ts', line: 2 },
    name: 'Automatic',
    symbolId: 'index:Automatic',
  } satisfies Type);
});
