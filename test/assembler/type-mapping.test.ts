import * as spec from '@jsii/spec';

import { compileJsiiForTest } from '../../src/helpers';

/**
 * Compiles a class with one property of the given TypeScript type, and returns the type the assembly gives it.
 */
function propertyType(typescript: string, declarations = ''): spec.OptionalValue {
  const { assembly } = compileJsiiForTest(`
    ${declarations}
    export interface IHolder { readonly value: ${typescript} }
  `);
  const holder = assembly.types?.['testpkg.IHolder'] as spec.InterfaceType;
  return holder.properties![0];
}

describe('primitive types', () => {
  test.each([
    ['string', 'string'],
    ['number', 'number'],
    ['boolean', 'boolean'],
    ['Date', 'date'],
    ['any', 'any'],
  ])('%s is the primitive "%s"', (typescript, primitive) => {
    expect(propertyType(typescript).type).toEqual({ primitive });
  });

  test('"unknown" is mapped to "any"', () => {
    expect(propertyType('unknown').type).toEqual({ primitive: 'any' });
  });

  test('a type alias of a primitive is the primitive', () => {
    expect(propertyType('Name', 'export type Name = string;').type).toEqual({ primitive: 'string' });
  });
});

describe('optional values', () => {
  test('a question mark makes a property optional', () => {
    const { assembly } = compileJsiiForTest('export interface IHolder { readonly value?: string }');

    expect((assembly.types!['testpkg.IHolder'] as spec.InterfaceType).properties![0]).toMatchObject({
      optional: true,
      type: { primitive: 'string' },
    });
  });

  test('a union with undefined is an optional value of the other type', () => {
    expect(propertyType('string | undefined')).toEqual(
      expect.objectContaining({ optional: true, type: { primitive: 'string' } }),
    );
  });

  test('a property that is required is not optional', () => {
    expect(propertyType('string').optional).toBeUndefined();
  });
});

describe('collections', () => {
  test.each([
    ['string[]', 'array', { primitive: 'string' }],
    ['Array<number>', 'array', { primitive: 'number' }],
    ['readonly string[]', 'array', { primitive: 'string' }],
    ['ReadonlyArray<boolean>', 'array', { primitive: 'boolean' }],
    ['Record<string, number>', 'map', { primitive: 'number' }],
    ['{ [key: string]: boolean }', 'map', { primitive: 'boolean' }],
  ])('%s is a %s of %j', (typescript, kind, elementtype) => {
    expect(propertyType(typescript).type).toEqual({ collection: { kind, elementtype } });
  });

  test('collections can be nested', () => {
    expect(propertyType('Record<string, string[]>').type).toEqual({
      collection: {
        kind: 'map',
        elementtype: { collection: { kind: 'array', elementtype: { primitive: 'string' } } },
      },
    });
  });

  test('the elements of a collection can be of a type of the package', () => {
    expect(propertyType('Item[]', 'export interface Item { readonly name: string }').type).toEqual({
      collection: { kind: 'array', elementtype: { fqn: 'testpkg.Item' } },
    });
  });

  test('the elements of a collection can be a union', () => {
    expect(propertyType('Array<string | number>').type).toEqual({
      collection: {
        kind: 'array',
        elementtype: { union: { types: [{ primitive: 'number' }, { primitive: 'string' }] } },
      },
    });
  });
});

describe('union types', () => {
  test('a union of primitives lists its members', () => {
    expect(propertyType('string | number').type).toEqual({
      union: { types: [{ primitive: 'number' }, { primitive: 'string' }] },
    });
  });

  test('a union can contain types of the package', () => {
    expect(
      propertyType(
        'Left | Right',
        'export interface Left { readonly l: string }\nexport interface Right { readonly r: string }',
      ).type,
    ).toEqual({
      union: { types: [{ fqn: 'testpkg.Left' }, { fqn: 'testpkg.Right' }] },
    });
  });

  test('a union of string literals is a string', () => {
    expect(propertyType("'a' | 'b'").type).toEqual({ primitive: 'string' });
  });

  test('a union of a type with itself is that type', () => {
    expect(propertyType('string | string').type).toEqual({ primitive: 'string' });
  });
});
