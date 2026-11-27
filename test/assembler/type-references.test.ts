import * as spec from '@jsii/spec';
import { compileForDiagnostics } from './helpers';
import { compileJsiiForTest } from '../../src/helpers';

describe('JSII3999 type-model/incoherent-type-model', () => {
  // Places that take a type but cannot express that the value is optional.
  test.each([
    { where: 'the type of a promise', type: 'Promise<string | undefined>', body: 'return Promise.resolve(undefined);' },
    { where: 'the element type of an array', type: 'Array<string | undefined>', body: 'return [];' },
  ])('is reported for an optional value as $where', ({ type, body }) => {
    expect(
      compileForDiagnostics(`
        export class Klass {
          public method(): ${type} {
            ${body}
          }
        }
      `),
    ).toEqual(['JSII3999: Encountered optional value in location where a plain type reference is expected']);
  });
});

describe('union types', () => {
  test('list their members in a fixed order: primitives, named types, collections, each sorted by name', () => {
    const result = compileJsiiForTest(`
      export class Zebra {}
      export class Apple {}
      export interface Props {
        readonly value: string[] | Zebra | number | Record<string, boolean> | Apple | boolean | Array<number | Zebra | string>;
      }
    `);

    const props = result.assembly.types!['testpkg.Props'] as spec.InterfaceType;
    expect(spec.describeTypeReference(props.properties![0].type)).toBe(
      'boolean | number | testpkg.Apple | testpkg.Zebra | array<number | string | testpkg.Zebra> | array<string> | map<boolean>',
    );
  });
});
