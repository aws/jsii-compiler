import * as spec from '@jsii/spec';

import { isAllowedCovariantSubtype } from '../../../src/type-analysis';
import { createTypeResolver } from '../../../src/type-reference';

const named = (fqn: string): spec.NamedTypeReference => ({ fqn });
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
const primitive = (p: spec.PrimitiveType): spec.PrimitiveTypeReference => ({ primitive: p });

function classType(name: string, base?: string, interfaces?: string[]): spec.ClassType {
  return {
    assembly: 'test',
    fqn: `test.${name}`,
    kind: spec.TypeKind.Class,
    name,
    base: base ? `test.${base}` : undefined,
    interfaces: interfaces?.map((i) => `test.${i}`),
  };
}

function interfaceType(name: string, interfaces?: string[]): spec.InterfaceType {
  return {
    assembly: 'test',
    fqn: `test.${name}`,
    kind: spec.TypeKind.Interface,
    name,
    interfaces: interfaces?.map((i) => `test.${i}`),
  };
}

function enumType(name: string): spec.EnumType {
  return { assembly: 'test', fqn: `test.${name}`, kind: spec.TypeKind.Enum, name, members: [] };
}

/**
 * Hierarchy used by the tests:
 *
 *   Base <- Middle <- Leaf                    (classes)
 *   IRoot <- IMid <- ILeaf                    (interfaces)
 *   Middle implements IMid; Leaf implements IOther
 *   Implementer extends Middle  (inherits IMid via its base class)
 *   Unrelated, Color (enum)
 */
const types: Record<string, spec.Type> = Object.fromEntries(
  [
    classType('Base'),
    classType('Middle', 'Base', ['IMid']),
    classType('Leaf', 'Middle', ['IOther']),
    classType('Inheritor', 'Middle'),
    classType('Unrelated'),
    classType('ExtendsEnum', 'Color'),
    interfaceType('IRoot'),
    interfaceType('IMid', ['IRoot']),
    interfaceType('ILeaf', ['IMid']),
    interfaceType('IOther'),
    interfaceType('IUnrelated'),
    enumType('Color'),
  ].map((t) => [t.fqn, t]),
);

const assembly = {
  name: 'test',
  types,
} as unknown as spec.Assembly;

const dereference = createTypeResolver(assembly, []);

function isCovariant(sub: spec.TypeReference | undefined, sup: spec.TypeReference | undefined) {
  return isAllowedCovariantSubtype(sub, sup, dereference);
}

describe('isAllowedCovariantSubtype', () => {
  describe('void and identical types', () => {
    test('void is covariant to void', () => {
      expect(isCovariant(undefined, undefined)).toBe(true);
    });

    test('void is not covariant to a type, nor the other way around', () => {
      expect(isCovariant(undefined, named('test.Base'))).toBe(false);
      expect(isCovariant(named('test.Base'), undefined)).toBe(false);
    });

    test.each([
      ['named', named('test.Unrelated')],
      ['primitive', primitive(spec.PrimitiveType.String)],
      ['map', map(primitive(spec.PrimitiveType.Number))],
      ['union', union(primitive(spec.PrimitiveType.String), primitive(spec.PrimitiveType.Number))],
      ['intersection', intersection(named('test.IRoot'), named('test.IOther'))],
    ])('identical %s types are covariant', (_, ref) => {
      expect(isCovariant(ref, JSON.parse(JSON.stringify(ref)))).toBe(true);
    });
  });

  describe('collections', () => {
    test('arrays are covariant if their element types are', () => {
      expect(isCovariant(array(named('test.Middle')), array(named('test.Base')))).toBe(true);
      expect(isCovariant(array(array(named('test.Leaf'))), array(array(named('test.Base'))))).toBe(true);
    });

    test('arrays are not covariant if their element types are not', () => {
      expect(isCovariant(array(named('test.Base')), array(named('test.Middle')))).toBe(false);
    });

    test('maps with different element types are never covariant', () => {
      expect(isCovariant(map(named('test.Middle')), map(named('test.Base')))).toBe(false);
    });

    test('arrays and maps are not covariant to each other', () => {
      expect(isCovariant(array(named('test.Middle')), map(named('test.Base')))).toBe(false);
      expect(isCovariant(map(named('test.Middle')), array(named('test.Base')))).toBe(false);
    });
  });

  describe('unions, intersections and primitives', () => {
    test('different unions are not covariant', () => {
      const a = union(named('test.Middle'), primitive(spec.PrimitiveType.String));
      const b = union(named('test.Base'), primitive(spec.PrimitiveType.String));
      expect(isCovariant(a, b)).toBe(false);
    });

    test('a union is not covariant to a member type, nor the other way around', () => {
      const u = union(named('test.Middle'), named('test.Base'));
      expect(isCovariant(u, named('test.Base'))).toBe(false);
      expect(isCovariant(named('test.Middle'), u)).toBe(false);
    });

    test('different intersections are not covariant', () => {
      expect(isCovariant(intersection(named('test.IMid'), named('test.IOther')), named('test.IRoot'))).toBe(false);
      expect(isCovariant(named('test.IMid'), intersection(named('test.IRoot'), named('test.IOther')))).toBe(false);
    });

    test('different primitives are not covariant', () => {
      expect(isCovariant(primitive(spec.PrimitiveType.String), primitive(spec.PrimitiveType.Number))).toBe(false);
    });

    test('a primitive is not covariant to a named type, nor the other way around', () => {
      expect(isCovariant(primitive(spec.PrimitiveType.Any), named('test.Base'))).toBe(false);
      expect(isCovariant(named('test.Base'), primitive(spec.PrimitiveType.Any))).toBe(false);
    });

    test('a collection is not covariant to a named type', () => {
      expect(isCovariant(array(named('test.Middle')), named('test.Base'))).toBe(false);
      expect(isCovariant(named('test.Middle'), array(named('test.Base')))).toBe(false);
    });
  });

  describe('named types', () => {
    test('types that cannot be resolved are not covariant', () => {
      expect(isCovariant(named('test.Missing'), named('test.Base'))).toBe(false);
      expect(isCovariant(named('test.Middle'), named('test.Missing'))).toBe(false);
      expect(isCovariant(named('other.Middle'), named('test.Base'))).toBe(false);
    });

    describe('class to class', () => {
      test('a subclass is covariant to its direct base', () => {
        expect(isCovariant(named('test.Middle'), named('test.Base'))).toBe(true);
      });

      test('a subclass is covariant to a distant ancestor', () => {
        expect(isCovariant(named('test.Leaf'), named('test.Base'))).toBe(true);
      });

      test('a base class is not covariant to its subclass', () => {
        expect(isCovariant(named('test.Base'), named('test.Leaf'))).toBe(false);
      });

      test('unrelated classes are not covariant', () => {
        expect(isCovariant(named('test.Unrelated'), named('test.Base'))).toBe(false);
      });

      test('a base chain that ends in a non-class does not match', () => {
        expect(isCovariant(named('test.ExtendsEnum'), named('test.Base'))).toBe(false);
      });
    });

    describe('interface to interface', () => {
      test('an interface is covariant to the interface it extends, directly or transitively', () => {
        expect(isCovariant(named('test.IMid'), named('test.IRoot'))).toBe(true);
        expect(isCovariant(named('test.ILeaf'), named('test.IRoot'))).toBe(true);
      });

      test('two references that resolve to the same interface are covariant', () => {
        // The references are not deeply equal, but both resolve to the same interface type
        const withExtraProperty = { fqn: 'test.IMid', extra: true } as spec.NamedTypeReference;
        expect(isCovariant(withExtraProperty, named('test.IMid'))).toBe(true);
      });

      test('an interface is not covariant to an unrelated interface', () => {
        expect(isCovariant(named('test.ILeaf'), named('test.IUnrelated'))).toBe(false);
        expect(isCovariant(named('test.IRoot'), named('test.IMid'))).toBe(false);
      });
    });

    describe('class to interface', () => {
      test('a class is covariant to an interface it implements directly', () => {
        expect(isCovariant(named('test.Middle'), named('test.IMid'))).toBe(true);
      });

      test('a class is covariant to an interface extended by an interface it implements', () => {
        expect(isCovariant(named('test.Middle'), named('test.IRoot'))).toBe(true);
      });

      test('a class is covariant to an interface implemented by its base class', () => {
        expect(isCovariant(named('test.Inheritor'), named('test.IMid'))).toBe(true);
        expect(isCovariant(named('test.Leaf'), named('test.IRoot'))).toBe(true);
      });

      test('a class is not covariant to an interface it does not implement', () => {
        expect(isCovariant(named('test.Base'), named('test.IMid'))).toBe(false);
        expect(isCovariant(named('test.Unrelated'), named('test.IUnrelated'))).toBe(false);
        expect(isCovariant(named('test.Middle'), named('test.IOther'))).toBe(false);
      });

      test('a class whose base is not a class does not inherit interfaces', () => {
        expect(isCovariant(named('test.ExtendsEnum'), named('test.IMid'))).toBe(false);
      });
    });

    test('an interface is not covariant to a class', () => {
      expect(isCovariant(named('test.IMid'), named('test.Base'))).toBe(false);
    });

    test('enums are only covariant to themselves', () => {
      expect(isCovariant(named('test.Color'), named('test.Color'))).toBe(true);
      expect(isCovariant(named('test.Color'), named('test.Base'))).toBe(false);
      expect(isCovariant(named('test.Base'), named('test.Color'))).toBe(false);
    });
  });
});
