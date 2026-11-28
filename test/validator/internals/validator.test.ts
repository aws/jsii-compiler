import * as spec from '@jsii/spec';
import { JsiiDiagnostic } from '../../../src/jsii-diagnostic';
import { ProjectInfo } from '../../../src/project-info';
import { Validator } from '../../../src/validator';

// These tests run the validator directly on hand-written assemblies. This
// reaches checks that the assembler never gets to exercise, because it either
// rejects the source code first, or always produces a well-formed model.

describe('type references', () => {
  test('JSII9000: a type from an assembly that is not in the dependency closure', () => {
    const diagnostics = validate(
      assemblyWith({
        'testpkg.Klass': klass('Klass', { methods: [{ name: 'method', returns: { type: { fqn: 'other.Foreign' } } }] }),
      }),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        jsiiCode: 9000,
        messageText: 'Encountered use of module that is not declared in "dependencies" or "peerDependencies": "other"',
      }),
    ]);
  });

  test('JSII9001: a type that the dependency does not declare', () => {
    const diagnostics = validate(
      assemblyWith({
        'testpkg.Klass': klass('Klass', { methods: [{ name: 'method', returns: { type: { fqn: 'other.Missing' } } }] }),
      }),
      [dependency('other', { 'other.Foreign': klass('Foreign', { assembly: 'other', fqn: 'other.Foreign' }) })],
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        jsiiCode: 9001,
        messageText: 'Type not found in the corresponding assembly: "other.Missing"',
      }),
    ]);
  });

  test('a type that the dependency declares is valid', () => {
    const diagnostics = validate(
      assemblyWith({
        'testpkg.Klass': klass('Klass', { methods: [{ name: 'method', returns: { type: { fqn: 'other.Foreign' } } }] }),
      }),
      [dependency('other', { 'other.Foreign': klass('Foreign', { assembly: 'other', fqn: 'other.Foreign' }) })],
    );

    expect(diagnostics).toEqual([]);
  });
});

describe('assemblies without types', () => {
  // "types" is optional in the assembly schema.
  test('an assembly without types is valid', () => {
    const assembly = assemblyWith({});
    delete assembly.types;

    expect(validate(assembly)).toEqual([]);
  });
});

describe('member names', () => {
  test('members without a name are skipped by the Java getter and setter checks', () => {
    // The spec requires a name, the validator still guards against its absence.
    const diagnostics = validate(
      assemblyWith({
        'testpkg.Klass': klass('Klass', { methods: [{} as spec.Method, { name: 'getFoo' }] }),
      }),
    );

    expect(diagnostics).toEqual([expect.objectContaining({ jsiiCode: 5000 })]);
  });

  test('a member that is not bound to a source node gets a diagnostic without a location', () => {
    const diagnostics = validate(
      assemblyWith({
        'testpkg.Klass': klass('Klass', { methods: [{ name: 'getFoo' }] }),
      }),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        jsiiCode: 5000,
        messageText: expect.stringContaining('Rename "Klass.getFoo"'),
        file: undefined,
        start: undefined,
      }),
    ]);
  });
});

describe('inheritance', () => {
  test('members of a class whose base class cannot be resolved are not marked as overrides', () => {
    const method: spec.Method = { name: 'method' };
    const property: spec.Property = { name: 'prop', type: { primitive: spec.PrimitiveType.String } };
    const diagnostics = validate(
      assemblyWith({
        'testpkg.Klass': klass('Klass', { base: 'testpkg.Missing', methods: [method], properties: [property] }),
      }),
    );

    // The unresolvable base itself is reported...
    expect(diagnostics).toEqual([
      expect.objectContaining({
        jsiiCode: 3000,
        messageText: 'Exported APIs cannot use un-exported type "testpkg.Missing"',
      }),
    ]);
    // ...and nothing is recorded as overriding it.
    expect(method.overrides).toBeUndefined();
    expect(property.overrides).toBeUndefined();
  });

  test('an abstract class "implementing" a class is not checked for optional properties', () => {
    // JSII5021 only applies to interfaces. A class in the "interfaces" list is reported elsewhere (JSII3005).
    const diagnostics = validate(
      assemblyWith({
        'testpkg.Other': klass('Other', {
          properties: [{ name: 'prop', optional: true, type: { primitive: spec.PrimitiveType.String } }],
        }),
        'testpkg.Klass': klass('Klass', { abstract: true, interfaces: ['testpkg.Other'] }),
      }),
    );

    expect(diagnostics.map((d) => d.jsiiCode)).not.toContain(5021);
  });

  test('JSII5021: an abstract class that does not declare an optional interface property', () => {
    const diagnostics = validate(
      assemblyWith({
        'testpkg.IOther': {
          assembly: 'testpkg',
          fqn: 'testpkg.IOther',
          kind: spec.TypeKind.Interface,
          name: 'IOther',
          properties: [
            { abstract: true, name: 'prop', optional: true, type: { primitive: spec.PrimitiveType.String } },
          ],
        },
        'testpkg.Klass': klass('Klass', { abstract: true, interfaces: ['testpkg.IOther'] }),
      }),
    );

    expect(diagnostics).toEqual([expect.objectContaining({ jsiiCode: 5021 })]);
  });
});

describe('JSII5020 language-compatibility/static-member-name-conflicts-with-nested-type', () => {
  test('is reported for an enum member and a type nested in the enum', () => {
    const diagnostics = validate(
      assemblyWith({
        'testpkg.Enum': {
          assembly: 'testpkg',
          fqn: 'testpkg.Enum',
          kind: spec.TypeKind.Enum,
          name: 'Enum',
          members: [{ name: 'A' }, { name: 'B' }],
        },
        'testpkg.Enum.A': klass('A', { fqn: 'testpkg.Enum.A', namespace: 'Enum' }),
      }),
    );

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 5020,
        messageText:
          'The static member "Enum.A" has the same PascalCased representation as nested type "Enum.A". This would result in invalid code in Go.',
      }),
    );
  });
});

function validate(assembly: spec.Assembly, dependencyClosure: spec.Assembly[] = []): JsiiDiagnostic[] {
  // The validator only reads the dependency closure from the project info.
  const projectInfo = { dependencyClosure } as unknown as ProjectInfo;
  return new Validator(projectInfo, assembly).emit().diagnostics.filter(JsiiDiagnostic.isJsiiDiagnostic);
}

function assemblyWith(types: spec.Assembly['types']): spec.Assembly {
  return dependency('testpkg', types);
}

function dependency(name: string, types: spec.Assembly['types']): spec.Assembly {
  return {
    schema: spec.SchemaVersion.LATEST,
    name,
    version: '0.0.1',
    license: 'Apache-2.0',
    author: { name: 'John Doe', roles: ['author'] },
    description: name,
    homepage: 'https://github.com/aws/jsii-compiler',
    repository: { type: 'git', url: 'https://github.com/aws/jsii-compiler.git' },
    jsiiVersion: '0.0.0',
    fingerprint: '<TBD>',
    types,
  };
}

function klass(name: string, props: Partial<spec.ClassType> = {}): spec.ClassType {
  return {
    assembly: 'testpkg',
    fqn: `testpkg.${name}`,
    kind: spec.TypeKind.Class,
    name,
    ...props,
  };
}
