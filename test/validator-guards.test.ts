import * as spec from '@jsii/spec';

import { ProjectInfo } from '../src/project-info';
import { Validator } from '../src/validator';

// The assembler never lists a class among the interfaces of a type, so these tests hand the validator an assembly
// that does, to exercise the abstract-class branch of the "implements" checks.
describe('a class listed as an implemented interface', () => {
  test('members are matched against the interfaces of its base, through abstract classes', () => {
    const assembly = makeAssembly({
      'testpkg.IFace': {
        kind: spec.TypeKind.Interface,
        methods: [{ name: 'method', abstract: true }],
        properties: [{ name: 'prop', type: STRING, abstract: true }],
      },
      'testpkg.Base': {
        kind: spec.TypeKind.Class,
        interfaces: ['testpkg.IFace'],
        methods: [{ name: 'method' }],
        properties: [{ name: 'prop', type: STRING }],
      },
      'testpkg.AbstractBase': { kind: spec.TypeKind.Class, abstract: true, base: 'testpkg.Base' },
      'testpkg.Impl': {
        kind: spec.TypeKind.Class,
        interfaces: ['testpkg.AbstractBase'],
        methods: [{ name: 'method' }],
        properties: [{ name: 'prop', type: STRING }],
      },
    });

    const result = new Validator(PROJECT_INFO, assembly).emit();

    expect(result.diagnostics).toEqual([]);
    const impl = assembly.types!['testpkg.Impl'] as spec.ClassType;
    expect(impl.methods).toEqual([{ name: 'method', overrides: 'testpkg.IFace' }]);
    expect(impl.properties).toEqual([{ name: 'prop', type: STRING, overrides: 'testpkg.IFace' }]);
  });

  test('members are not matched when the class is not abstract', () => {
    const assembly = makeAssembly({
      'testpkg.IFace': {
        kind: spec.TypeKind.Interface,
        methods: [{ name: 'method', abstract: true }],
        properties: [{ name: 'prop', type: STRING, abstract: true }],
      },
      'testpkg.Base': { kind: spec.TypeKind.Class, interfaces: ['testpkg.IFace'] },
      'testpkg.ConcreteBase': { kind: spec.TypeKind.Class, base: 'testpkg.Base' },
      'testpkg.Impl': {
        kind: spec.TypeKind.Class,
        interfaces: ['testpkg.ConcreteBase'],
        methods: [{ name: 'method' }],
        properties: [{ name: 'prop', type: STRING }],
      },
    });

    const result = new Validator(PROJECT_INFO, assembly).emit();

    expect(result.diagnostics).toEqual([]);
    const impl = assembly.types!['testpkg.Impl'] as spec.ClassType;
    expect(impl.methods).toEqual([{ name: 'method' }]);
    expect(impl.properties).toEqual([{ name: 'prop', type: STRING }]);
  });
});

const STRING: spec.TypeReference = { primitive: spec.PrimitiveType.String };

const PROJECT_INFO = {
  name: 'testpkg',
  dependencyClosure: [],
} as unknown as ProjectInfo;

function makeAssembly(
  types: Record<string, Omit<spec.ClassType, 'kind' | 'fqn' | 'name' | 'assembly'> & { kind: spec.TypeKind }>,
): spec.Assembly {
  return {
    schema: spec.SchemaVersion.LATEST,
    name: 'testpkg',
    version: '0.0.1',
    license: 'Apache-2.0',
    description: 'testpkg',
    homepage: 'https://example.com',
    author: { name: 'Test', roles: ['author'] },
    repository: { type: 'git', url: 'https://example.com' },
    jsiiVersion: '0.0.0',
    fingerprint: '<TBD>',
    types: Object.fromEntries(
      Object.entries(types).map(([fqn, type]) => [
        fqn,
        { ...type, fqn, assembly: 'testpkg', name: fqn.split('.')[1] } as spec.Type,
      ]),
    ),
  };
}
