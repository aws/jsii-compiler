import * as spec from '@jsii/spec';
import * as deepEqual from 'fast-deep-equal';
import { TypeResolver } from './type-reference';

/**
 * Check if subType is an allowed covariant subtype to superType
 *
 * This is not a generic check for subtypes or covariance, but a specific implementation
 * that checks the currently allowed conditions for class covariance.
 * In practice, this is driven by C# limitations.
 */
export function isAllowedCovariantSubtype(
  subType: spec.TypeReference | undefined,
  superType: spec.TypeReference | undefined,
  dereference: TypeResolver,
): boolean {
  // one void, while other isn't => not covariant
  if ((subType === undefined) !== (superType === undefined)) {
    return false;
  }

  // Same type is always covariant
  if (deepEqual(subType, superType)) {
    return true;
  }

  // Handle array collections (covariant)
  if (spec.isCollectionTypeReference(subType) && spec.isCollectionTypeReference(superType)) {
    if (subType.collection.kind === 'array' && superType.collection.kind === 'array') {
      return isAllowedCovariantSubtype(subType.collection.elementtype, superType.collection.elementtype, dereference);
    }
    // Maps are not allowed to be covariant in C#, so we exclude them here.
    // This seems to be because we use C# Dictionary to implements Maps, which are using generics and generics are not allowed to be covariant
    return false;
  }

  // Union types are currently not allowed, because we have not seen the need for it.
  // Technically narrowing (removing `| Type` or subtyping) could be allowed and this works in C#.
  if (spec.isUnionTypeReference(subType) || spec.isUnionTypeReference(superType)) {
    return false;
  }

  // Intersection types are invalid, because intersections are only allowed as inputs
  // and covariance is only allowed in outputs.
  if (spec.isIntersectionTypeReference(subType) || spec.isIntersectionTypeReference(superType)) {
    return false;
  }

  // Primitives can never be covariant to each other in C#
  if (spec.isPrimitiveTypeReference(subType) || spec.isPrimitiveTypeReference(superType)) {
    return false;
  }

  // We really only support covariance for named types (and lists of named types).
  // To be safe, let's guard against any unknown cases.
  if (!spec.isNamedTypeReference(subType) || !spec.isNamedTypeReference(superType)) {
    return false;
  }

  const subTypeSpec = dereference(subType.fqn);
  const superTypeSpec = dereference(superType.fqn);

  if (!subTypeSpec || !superTypeSpec) {
    return false;
  }

  // Handle class-to-class inheritance
  if (spec.isClassType(subTypeSpec) && spec.isClassType(superTypeSpec)) {
    return _classExtendsClass(subTypeSpec, superType.fqn);
  }

  // Handle interface-to-interface inheritance
  if (spec.isInterfaceType(subTypeSpec) && spec.isInterfaceType(superTypeSpec)) {
    return _interfaceExtendsInterface(subTypeSpec, superType.fqn);
  }

  // Handle class implementing interface
  if (spec.isClassType(subTypeSpec) && spec.isInterfaceType(superTypeSpec)) {
    return _classImplementsInterface(subTypeSpec, superType.fqn);
  }

  return false;

  function _classExtendsClass(classType: spec.ClassType, targetFqn: string): boolean {
    let current = classType;
    while (current.base) {
      if (current.base === targetFqn) {
        return true;
      }
      const baseType = dereference(current.base);
      if (!spec.isClassType(baseType)) {
        break;
      }
      current = baseType;
    }
    return false;
  }

  function _classImplementsInterface(classType: spec.ClassType, interfaceFqn: string): boolean {
    // Check direct interfaces
    if (classType.interfaces?.includes(interfaceFqn)) {
      return true;
    }

    // Check inherited interfaces
    if (classType.interfaces) {
      for (const iface of classType.interfaces) {
        const ifaceType = dereference(iface);
        if (spec.isInterfaceType(ifaceType) && _interfaceExtendsInterface(ifaceType, interfaceFqn)) {
          return true;
        }
      }
    }

    // Check base class interfaces
    if (classType.base) {
      const baseType = dereference(classType.base);
      if (spec.isClassType(baseType)) {
        return _classImplementsInterface(baseType, interfaceFqn);
      }
    }

    return false;
  }

  function _interfaceExtendsInterface(interfaceType: spec.InterfaceType, targetFqn: string): boolean {
    if (interfaceType.fqn === targetFqn) {
      return true;
    }

    if (interfaceType.interfaces) {
      for (const iface of interfaceType.interfaces) {
        if (iface === targetFqn) {
          return true;
        }
        const ifaceType = dereference(iface);
        if (spec.isInterfaceType(ifaceType) && _interfaceExtendsInterface(ifaceType, targetFqn)) {
          return true;
        }
      }
    }

    return false;
  }
}
