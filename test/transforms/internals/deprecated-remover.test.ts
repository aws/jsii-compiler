import * as spec from '@jsii/spec';
import * as ts from 'typescript';

import * as bindings from '../../../src/node-bindings';
import { DeprecatedRemover } from '../../../src/transforms/deprecated-remover';

/**
 * The `DeprecatedRemover` validates the shape of the assemblies it is handed. These tests call it directly with
 * assemblies that the assembler never generates.
 */

describe('removeFrom', () => {
  test('is a no-op for an assembly without types', () => {
    const remover = new DeprecatedRemover(undefined as any, undefined);

    expect(remover.removeFrom({ name: 'empty' } as spec.Assembly)).toEqual([]);
  });

  test('rejects types that are neither enums, classes nor interfaces', () => {
    const remover = new DeprecatedRemover(undefined as any, undefined);
    const assembly = assemblyWith({
      'test.Weird': { assembly: 'test', fqn: 'test.Weird', kind: 'weird', name: 'Weird' },
    });

    expect(() => remover.removeFrom(assembly)).toThrow(/^Unhandled type encountered! \{/);
    expect(() => remover.removeFrom(assembly)).toThrow(/"kind": "weird"/);
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

function assemblyWith(types: Record<string, any>): spec.Assembly {
  return { name: 'test', types } as any;
}
