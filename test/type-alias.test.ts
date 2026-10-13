import { PrimitiveType, Type, TypeKind } from '@jsii/spec';
import { DiagnosticCategory } from 'typescript';
import { compileJsiiForTest, sourceToAssemblyHelper } from '../lib';

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

test('type aliases reject unions containing multiple array members', () => {
  const result = compileJsiiForTest(
    `
    export class A {}
    export class B {}
    export class C {}

    export type X = A[] | B[] | C;

    export class UsesX {
      public constructor(public readonly value: X) {}
    }
    `,
    { captureDiagnostics: true },
  );

  expect(result.type).toBe('failure');
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      category: DiagnosticCategory.Error,
      messageText: expect.stringContaining('Union types cannot contain multiple array types'),
    }),
  );
});

test('type aliases allow union element arrays inside broader unions', () => {
  const assembly = sourceToAssemblyHelper(`
    export class A {}
    export class B {}
    export class C {}

    export type X = (A | B)[] | C;

    export class UsesX {
      public constructor(public readonly value: X) {}
    }
  `);

  const unionTypes = assembly.types!['testpkg.UsesX'].initializer!.parameters![0].type.union!.types;

  expect(unionTypes).toContainEqual({ fqn: 'testpkg.C' });
  expect(unionTypes).toContainEqual({
    collection: {
      elementtype: {
        union: {
          types: [{ fqn: 'testpkg.A' }, { fqn: 'testpkg.B' }],
        },
      },
      kind: 'array',
    },
  });
});
