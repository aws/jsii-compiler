import { sourceToAssemblyHelper } from '../lib';

// ----------------------------------------------------------------------
test('Class properties are inferred from the constructor', () => {
  const assembly = sourceToAssemblyHelper(`
    export class Dog {
        ageInDogYears;
        breed;
        constructor(years: number, breed: string) {
            // because dogYears and regular years are different!
            this.ageInDogYears = years * 7;
            this.breed = breed;
        }
    }
  `);

  expect(assembly.types!['testpkg.Dog']).toEqual({
    assembly: 'testpkg',
    fqn: 'testpkg.Dog',
    kind: 'class',
    initializer: {
      locationInModule: { filename: 'index.ts', line: 5 },
      parameters: [
        {
          name: 'years',
          type: {
            primitive: 'number',
          },
        },
        {
          name: 'breed',
          type: {
            primitive: 'string',
          },
        },
      ],
    },
    locationInModule: { filename: 'index.ts', line: 2 },
    name: 'Dog',
    properties: [
      {
        locationInModule: { filename: 'index.ts', line: 3 },
        name: 'ageInDogYears',
        type: {
          primitive: 'number',
        },
      },
      {
        locationInModule: { filename: 'index.ts', line: 4 },
        name: 'breed',
        type: {
          primitive: 'string',
        },
      },
    ],
    symbolId: 'index:Dog',
  });
});

test('Class property can not be inferred if property is potentially undefinied', () => {
  expect(() =>
    sourceToAssemblyHelper(`
      class Square {
        sideLength;
    
        constructor(sideLength: number) {
            if (Math.random()) {
                this.sideLength = sideLength;
            }
        }
    
        get area() {
            return this.sideLength ** 2;
        }
    }
      `),
  ).toThrow(/There were compiler errors/);
});
