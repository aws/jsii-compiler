import * as spec from '@jsii/spec';

import {
  createTypeResolver,
  resolveType,
  typeReferenceEqual,
  typeReferenceToString,
} from '../../../src/type-reference';

const named = (fqn: string): spec.NamedTypeReference => ({ fqn });
const primitive = (p: spec.PrimitiveType): spec.PrimitiveTypeReference => ({ primitive: p });
const array = (elementtype: spec.TypeReference): spec.CollectionTypeReference => ({
  collection: { kind: spec.CollectionKind.Array, elementtype },
});
const map = (elementtype: spec.TypeReference): spec.CollectionTypeReference => ({
  collection: { kind: spec.CollectionKind.Map, elementtype },
});
const union = (...types: spec.TypeReference[]): spec.UnionTypeReference => ({ union: { types } });
const intersection = (...types: spec.TypeReference[]): spec.IntersectionTypeReference => ({
  intersection: { types },
});

const str = primitive(spec.PrimitiveType.String);
const num = primitive(spec.PrimitiveType.Number);

describe('typeReferenceToString', () => {
  test.each([
    ['named', named('lib.Foo'), 'lib.Foo'],
    ['primitive', str, 'string'],
    ['array', array(named('lib.Foo')), 'array<lib.Foo>'],
    ['map', map(num), 'map<number>'],
    ['nested collections', array(map(str)), 'array<map<string>>'],
    ['union', union(str, num, named('lib.Foo')), 'string | number | lib.Foo'],
    ['intersection', intersection(named('lib.IA'), named('lib.IB')), 'lib.IA & lib.IB'],
    ['union inside a collection', array(union(str, num)), 'array<string | number>'],
  ])('%s', (_, ref, expected) => {
    expect(typeReferenceToString(ref)).toBe(expected);
  });
});

describe('typeReferenceEqual', () => {
  test('named types are equal if their fqns are', () => {
    expect(typeReferenceEqual(named('lib.Foo'), named('lib.Foo'))).toBe(true);
    expect(typeReferenceEqual(named('lib.Foo'), named('lib.Bar'))).toBe(false);
  });

  test('primitives are equal if they are the same primitive', () => {
    expect(typeReferenceEqual(str, primitive(spec.PrimitiveType.String))).toBe(true);
    expect(typeReferenceEqual(str, num)).toBe(false);
  });

  test('collections are equal if kind and element type are', () => {
    expect(typeReferenceEqual(array(str), array(str))).toBe(true);
    expect(typeReferenceEqual(array(str), array(num))).toBe(false);
    expect(typeReferenceEqual(array(str), map(str))).toBe(false);
  });

  test('unions are equal if their types are equal in order', () => {
    expect(typeReferenceEqual(union(str, num), union(str, num))).toBe(true);
    expect(typeReferenceEqual(union(str, num), union(num, str))).toBe(false);
    expect(typeReferenceEqual(union(str, num), union(str))).toBe(false);
  });

  test('intersections are equal if their types are equal in order', () => {
    const a = named('lib.IA');
    const b = named('lib.IB');
    expect(typeReferenceEqual(intersection(a, b), intersection(a, b))).toBe(true);
    expect(typeReferenceEqual(intersection(a, b), intersection(b, a))).toBe(false);
    expect(typeReferenceEqual(intersection(a, b), intersection(a))).toBe(false);
  });

  test('references of different kinds are never equal', () => {
    const refs = [named('lib.Foo'), str, array(str), union(str, num), intersection(named('lib.IA'), named('lib.IB'))];
    for (const a of refs) {
      for (const b of refs) {
        expect(typeReferenceEqual(a, b)).toBe(a === b);
      }
    }
  });
});

describe('resolveType and createTypeResolver', () => {
  const fooType: spec.ClassType = {
    assembly: 'main',
    fqn: 'main.Foo',
    kind: spec.TypeKind.Class,
    name: 'Foo',
  };
  const depType: spec.ClassType = {
    assembly: 'dep',
    fqn: 'dep.Bar',
    kind: spec.TypeKind.Class,
    name: 'Bar',
  };
  const main = { name: 'main', types: { 'main.Foo': fooType } } as unknown as spec.Assembly;
  const dep = { name: 'dep', types: { 'dep.Bar': depType } } as unknown as spec.Assembly;
  const empty = { name: 'empty' } as unknown as spec.Assembly;

  test('resolves types from the main assembly by name or by reference', () => {
    expect(resolveType('main.Foo', main, [dep])).toBe(fooType);
    expect(resolveType(named('main.Foo'), main, [dep])).toBe(fooType);
  });

  test('resolves types from the dependency closure', () => {
    expect(resolveType('dep.Bar', main, [empty, dep])).toBe(depType);
    expect(resolveType(named('dep.Bar'), main, [dep])).toBe(depType);
  });

  test('returns undefined for unknown types', () => {
    expect(resolveType('main.Missing', main, [dep])).toBeUndefined();
    expect(resolveType('dep.Missing', main, [dep])).toBeUndefined();
    expect(resolveType('unknown.Foo', main, [dep])).toBeUndefined();
  });

  test('returns undefined if the matching assembly has no types', () => {
    expect(resolveType('empty.Foo', main, [empty])).toBeUndefined();
    expect(resolveType('empty.Foo', empty, [])).toBeUndefined();
  });

  test('createTypeResolver binds the assembly and dependency closure', () => {
    const resolver = createTypeResolver(main, [dep]);

    expect(resolver('main.Foo')).toBe(fooType);
    expect(resolver(named('dep.Bar'))).toBe(depType);
    expect(resolver('nope.Nope')).toBeUndefined();
  });
});
