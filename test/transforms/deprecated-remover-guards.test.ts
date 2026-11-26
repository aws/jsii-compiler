import * as spec from '@jsii/spec';
import * as ts from 'typescript';

import { compileJsiiForTest } from '../../src';
import * as bindings from '../../src/node-bindings';
import { DeprecatedRemover } from '../../src/transforms/deprecated-remover';

/**
 * The `DeprecatedRemover` validates the shape of the inputs it is handed. These tests exercise those internal
 * consistency checks by calling the remover (and the declaration transformations it produces) with inputs that the
 * assembler never generates.
 */

afterEach(() => {
  jest.restoreAllMocks();
});

describe('removeFrom', () => {
  test('rejects types that are neither enums, classes nor interfaces', () => {
    const remover = new DeprecatedRemover(undefined as any, undefined);
    const assembly = assemblyWith({
      'test.Weird': { assembly: 'test', fqn: 'test.Weird', kind: 'weird', name: 'Weird' },
    });

    expect(() => remover.removeFrom(assembly)).toThrow(/^Unhandled type encountered! \{/);
    expect(() => remover.removeFrom(assembly)).toThrow(/"kind": "weird"/);
  });

  test('reports no leftover use of deprecated APIs when the assembly has no types', () => {
    // `removeFrom` returns early for such assemblies, so the check is only reachable directly.
    const remover = new DeprecatedRemover(undefined as any, undefined);

    expect((remover as any).findLeftoverUseOfDeprecatedAPIs({ types: undefined }, new Set())).toEqual([]);
  });

  test('reports leftover usage of a deprecated type without related information when its declaration is unknown', () => {
    const remover = new DeprecatedRemover(undefined as any, undefined);

    // Real declarations for the member that uses the deprecated type, but none for the deprecated type itself.
    const holderDeclaration = ts
      .createSourceFile('holder.ts', 'interface Holder { readonly gone: Gone; }', ts.ScriptTarget.Latest, true)
      .statements.find(ts.isInterfaceDeclaration)!;
    const property: spec.Property = { name: 'gone', type: { fqn: 'test.Gone' } };
    bindings.setPropertyRelatedNode(property, holderDeclaration.members.find(ts.isPropertySignature));

    const diagnostics = remover.removeFrom(
      assemblyWith({
        'test.Gone': {
          assembly: 'test',
          docs: { stability: spec.Stability.Deprecated },
          fqn: 'test.Gone',
          kind: spec.TypeKind.Interface,
          name: 'Gone',
        },
        'test.Holder': {
          assembly: 'test',
          fqn: 'test.Holder',
          kind: spec.TypeKind.Interface,
          name: 'Holder',
          properties: [property],
        },
      }),
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].messageText).toBe(
      'Property has @deprecated type test.Gone, and it is erased by --strip-deprecated.',
    );
    expect(diagnostics[0].relatedInformation).toEqual([]);
  });
});

describe('declaration transformations', () => {
  const NOT_A_CLASS_OR_INTERFACE = ts.factory.createEnumDeclaration(undefined, 'NotAClass', []);
  const BARE_CLASS = ts.factory.createClassDeclaration(undefined, 'Bare', undefined, undefined, []);

  test('removing a base class only applies to class declarations', () => {
    const transformations = transformationsFor(`
      /** @deprecated gone */
      export class GoneBase {}
      export class Child extends GoneBase {}
    `);

    expect(transformations).toHaveLength(1);
    expect(() => transformations[0].apply(NOT_A_CLASS_OR_INTERFACE)).toThrow(
      'Expected a ClassDeclaration, found a EnumDeclaration',
    );
  });

  test('replacing a base class only applies to class declarations', () => {
    const transformations = transformationsFor(`
      export class Kept {}
      /** @deprecated gone */
      export class GoneBase extends Kept {}
      export class Child extends GoneBase {}
    `);

    expect(transformations).toHaveLength(1);
    expect(() => transformations[0].apply(NOT_A_CLASS_OR_INTERFACE)).toThrow(
      'Expected a ClassDeclaration, found a EnumDeclaration',
    );
  });

  describe('when an interface is removed and its parent is added back', () => {
    let transformations: Transformation[];
    beforeAll(() => {
      transformations = transformationsFor(`
        export interface IKept {}
        /** @deprecated gone */
        export interface IGone extends IKept {}
        export interface IChild extends IGone {}
      `);
    });

    test('adding and removing an interface only apply to class and interface declarations', () => {
      expect(transformations).toHaveLength(2);
      for (const transformation of transformations) {
        expect(() => transformation.apply(NOT_A_CLASS_OR_INTERFACE)).toThrow(
          'Expected a ClassDeclaration or InterfaceDeclaration, found a EnumDeclaration',
        );
      }
    });

    test('removing an interface from a declaration without heritage clauses leaves it without heritage clauses', () => {
      // Of the two transformations, only the removal can be applied to a declaration that has no resolvable symbols.
      const [removal] = transformations.filter((transformation) => {
        try {
          transformation.apply(BARE_CLASS);
          return true;
        } catch {
          return false;
        }
      });

      const { node } = removal.apply(BARE_CLASS) as { node: ts.ClassDeclaration };

      expect(ts.isClassDeclaration(node)).toBe(true);
      expect(node.name?.text).toBe('Bare');
      expect(node.heritageClauses).toBeUndefined();
    });
  });
});

function assemblyWith(types: Record<string, any>): spec.Assembly {
  return { name: 'test', types } as any;
}

interface Transformation {
  apply(node: ts.Node): { node: ts.Node };
}

/**
 * Compiles the provided source with `--strip-deprecated`, and returns the declaration transformations that the
 * `DeprecatedRemover` registered for it.
 */
function transformationsFor(source: string): Transformation[] {
  const removeFrom = jest.spyOn(DeprecatedRemover.prototype, 'removeFrom');
  try {
    compileJsiiForTest(source, undefined /* callback */, { stripDeprecated: true });
    expect(removeFrom).toHaveBeenCalledTimes(1);
    return (removeFrom.mock.contexts[0] as any).transformations;
  } finally {
    removeFrom.mockRestore();
  }
}
