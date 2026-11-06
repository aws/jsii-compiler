import * as spec from '@jsii/spec';
import { visitTypeReference } from './type-visitor';

/**
 * Convert a type reference to a string
 */
export function typeReferenceToString(x: spec.TypeReference): string {
  return visitTypeReference<string>(x, {
    named: function (ref: spec.NamedTypeReference) {
      return ref.fqn;
    },
    primitive: function (ref: spec.PrimitiveTypeReference) {
      return ref.primitive;
    },
    collection: function (ref: spec.CollectionTypeReference) {
      return `${ref.collection.kind}<${typeReferenceToString(ref.collection.elementtype)}>`;
    },
    union: function (ref: spec.UnionTypeReference) {
      return ref.union.types.map(typeReferenceToString).join(' | ');
    },
    intersection: function (ref: spec.IntersectionTypeReference) {
      return ref.intersection.types.map(typeReferenceToString).join(' & ');
    },
  });
}

/**
 * Return whether the given type references are equal
 */
export function typeReferenceEqual(a: spec.TypeReference, b: spec.TypeReference): boolean {
  if (spec.isNamedTypeReference(a) && spec.isNamedTypeReference(b)) {
    return a.fqn === b.fqn;
  }
  if (spec.isPrimitiveTypeReference(a) && spec.isPrimitiveTypeReference(b)) {
    return a.primitive === b.primitive;
  }
  if (spec.isCollectionTypeReference(a) && spec.isCollectionTypeReference(b)) {
    return (
      a.collection.kind === b.collection.kind && typeReferenceEqual(a.collection.elementtype, b.collection.elementtype)
    );
  }
  if (spec.isUnionTypeReference(a) && spec.isUnionTypeReference(b)) {
    return (
      a.union.types.length === b.union.types.length &&
      a.union.types.every((aType, i) => typeReferenceEqual(aType, b.union.types[i]))
    );
  }
  if (spec.isIntersectionTypeReference(a) && spec.isIntersectionTypeReference(b)) {
    return (
      a.intersection.types.length === b.intersection.types.length &&
      a.intersection.types.every((aType, i) => typeReferenceEqual(aType, b.intersection.types[i]))
    );
  }
  return false;
}

export type TypeResolver = (typeRef: string | spec.NamedTypeReference) => spec.Type | undefined;

/**
 * Creates a type resolver function for a given context (assembly + dependency closure).
 */
export function createTypeResolver(assembly: spec.Assembly, dependencyClosure: readonly spec.Assembly[]): TypeResolver {
  return (typeRef) => resolveType(typeRef, assembly, dependencyClosure);
}

/**
 * Resolve a type from a name to the actual type.
 * Uses a given assembly and dependency closure for lookup.
 */
export function resolveType(
  typeRef: string | spec.NamedTypeReference,
  assembly: spec.Assembly,
  dependencyClosure: readonly spec.Assembly[],
): spec.Type | undefined {
  if (typeof typeRef !== 'string') {
    typeRef = typeRef.fqn;
  }
  const [assm] = typeRef.split('.');
  if (assembly.name === assm) {
    return assembly.types?.[typeRef];
  }
  const foreignAssm = dependencyClosure.find((dep) => dep.name === assm);
  return foreignAssm?.types?.[typeRef];
}
