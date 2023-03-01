import { PrimitiveType, Type, TypeKind } from '@jsii/spec';
import { sourceToAssemblyHelper } from '../lib';

// ----------------------------------------------------------------------
test('type aliases with awaited and promise types', () => {
  const assembly = sourceToAssemblyHelper(`
    type AwaitedPromiseString = Awaited<Promise<string>>;
    type AwaitedPromisePromiseNumber = Awaited<Promise<Promise<number>>>;
    type AwaitedBooleanOrPromiseNumber = Awaited<boolean | Promise<number>>;

    export class AwaitedPromiseTypes {
        bar: AwaitedPromiseString;
        buzz: AwaitedPromisePromiseNumber;
        bam: AwaitedBooleanOrPromiseNumber;
        constructor(foo: AwaitedPromiseString,
                    fizz: AwaitedPromisePromiseNumber,
                    flam: AwaitedBooleanOrPromiseNumber) {
            this.bar = foo;
            this.buzz = fizz;
            this.bam = flam;
        }
    }
  `);
  expect(assembly.types!['testpkg.AwaitedPromiseTypes']).toEqual({
    assembly: 'testpkg',
    fqn: 'testpkg.AwaitedPromiseTypes',
    kind: TypeKind.Class,
    initializer: {
      locationInModule: { filename: 'index.ts', line: 10 },
      parameters: [
        {
          name: 'foo',
          type: {
            primitive: PrimitiveType.String,
          },
        },
        {
          name: 'fizz',
          type: {
            primitive: PrimitiveType.Number,
          },
        },
        {
          name: 'flam',
          type: {
            union: {
              types: [{ primitive: PrimitiveType.Number }, { primitive: PrimitiveType.Boolean }],
            },
          },
        },
      ],
    },
    locationInModule: { filename: 'index.ts', line: 6 },
    name: 'AwaitedPromiseTypes',
    properties: [
      {
        locationInModule: { filename: 'index.ts', line: 9 },
        name: 'bam',
        type: {
          union: {
            types: [{ primitive: PrimitiveType.Number }, { primitive: PrimitiveType.Boolean }],
          },
        },
      },
      {
        locationInModule: { filename: 'index.ts', line: 7 },
        name: 'bar',
        type: {
          primitive: PrimitiveType.String,
        },
      },
      {
        locationInModule: { filename: 'index.ts', line: 8 },
        name: 'buzz',
        type: {
          primitive: PrimitiveType.Number,
        },
      },
    ],
    symbolId: 'index:AwaitedPromiseTypes',
  } satisfies Type);
});
