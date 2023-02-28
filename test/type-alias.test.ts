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
    kind: 'class',
    initializer: {
        locationInModule: { filename: 'index.ts', line: 10 },
        parameters: [
            {
                name: 'foo',
                type: {
                    "primitive": "string",
                },
            },
            {
                name: 'fizz',
                type: {
                    "primitive": "number",
                },
            },
            {
                name: 'flam',
                type: {
                    "union": {
                        "types": [{"primitive": "number",}, {"primitive": "boolean",} ]
                    }
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
                "union": {
                    "types": [{"primitive": "number",}, {"primitive": "boolean",} ]
                }
            },
        },
        {
            locationInModule: { filename: 'index.ts', line: 7 },
            name: 'bar',
            type: {
                "primitive": "string",
            },
        },
        {
            locationInModule: { filename: 'index.ts', line: 8 },
            name: 'buzz',
            type: {
                "primitive": "number",
            },
        },
    ],
    symbolId: 'index:AwaitedPromiseTypes',
    });
});
