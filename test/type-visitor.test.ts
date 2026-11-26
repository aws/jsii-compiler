import * as spec from '@jsii/spec';

import {
  isBehavioralInterfaceType,
  isDataType,
  visitType,
  visitTypeReference,
  TypeReferenceVisitor,
  TypeVisitor,
} from '../src/type-visitor';

const referenceVisitor: TypeReferenceVisitor<string> = {
  named: (ref) => `named:${ref.fqn}`,
  primitive: (ref) => `primitive:${ref.primitive}`,
  collection: (ref) => `collection:${ref.collection.kind}`,
  union: (ref) => `union:${ref.union.types.length}`,
  intersection: (ref) => `intersection:${ref.intersection.types.length}`,
};

describe('visitTypeReference', () => {
  test.each<[string, spec.TypeReference, string]>([
    ['named', { fqn: 'lib.Foo' }, 'named:lib.Foo'],
    ['primitive', { primitive: spec.PrimitiveType.Boolean }, 'primitive:boolean'],
    [
      'collection',
      { collection: { kind: spec.CollectionKind.Map, elementtype: { primitive: spec.PrimitiveType.Any } } },
      'collection:map',
    ],
    [
      'union',
      { union: { types: [{ primitive: spec.PrimitiveType.String }, { primitive: spec.PrimitiveType.Number }] } },
      'union:2',
    ],
    ['intersection', { intersection: { types: [{ fqn: 'lib.IA' }, { fqn: 'lib.IB' }] } }, 'intersection:2'],
  ])('dispatches %s references to the matching visitor method', (_, ref, expected) => {
    expect(visitTypeReference(ref, referenceVisitor)).toBe(expected);
  });

  test('throws on a value that is not a type reference', () => {
    expect(() => visitTypeReference({ bogus: true } as unknown as spec.TypeReference, referenceVisitor)).toThrow(
      'Unknown type reference: {"bogus":true}',
    );
  });
});

const classType: spec.ClassType = { assembly: 'lib', fqn: 'lib.C', kind: spec.TypeKind.Class, name: 'C' };
const behavioralInterface: spec.InterfaceType = {
  assembly: 'lib',
  fqn: 'lib.I',
  kind: spec.TypeKind.Interface,
  name: 'I',
};
const dataInterface: spec.InterfaceType = {
  assembly: 'lib',
  fqn: 'lib.D',
  kind: spec.TypeKind.Interface,
  name: 'D',
  datatype: true,
};
const enumType: spec.EnumType = { assembly: 'lib', fqn: 'lib.E', kind: spec.TypeKind.Enum, name: 'E', members: [] };

const typeVisitor: TypeVisitor<string> = {
  classType: (t) => `class:${t.fqn}`,
  interfaceType: (t) => `interface:${t.fqn}`,
  dataType: (t) => `data:${t.fqn}`,
  enumType: (t) => `enum:${t.fqn}`,
};

describe('visitType', () => {
  test('dispatches classes, behavioral interfaces, data types and enums to the matching visitor method', () => {
    expect(visitType(classType, typeVisitor)).toBe('class:lib.C');
    expect(visitType(behavioralInterface, typeVisitor)).toBe('interface:lib.I');
    expect(visitType(dataInterface, typeVisitor)).toBe('data:lib.D');
    expect(visitType(enumType, typeVisitor)).toBe('enum:lib.E');
  });

  test('throws on a value that is not a type', () => {
    expect(() => visitType({ kind: 'bogus' } as unknown as spec.Type, typeVisitor)).toThrow(
      'Unknown type: {"kind":"bogus"}',
    );
  });
});

describe('isDataType / isBehavioralInterfaceType', () => {
  test('isDataType is true only for interfaces marked as datatype', () => {
    expect(isDataType(dataInterface)).toBe(true);
    expect(isDataType(behavioralInterface)).toBe(false);
    expect(isDataType(classType)).toBe(false);
    expect(isDataType(enumType)).toBe(false);
  });

  test('isBehavioralInterfaceType is true only for interfaces not marked as datatype', () => {
    expect(isBehavioralInterfaceType(behavioralInterface)).toBe(true);
    expect(isBehavioralInterfaceType(dataInterface)).toBe(false);
    expect(isBehavioralInterfaceType(classType)).toBe(false);
    expect(isBehavioralInterfaceType(enumType)).toBe(false);
  });
});
