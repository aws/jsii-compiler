import * as fs from 'node:fs';
import * as path from 'node:path';
import * as spec from '@jsii/spec';

import { compileJsiiForTest, TestWorkspace } from '../../src/helpers';

const DEPENDENCY_SOURCE = `
  export class Foreign {
    public hello(): number {
      return 1;
    }
  }
`;
const DEPENDS_ON_IT = { dependencies: { dependency: '*' }, peerDependencies: { dependency: '*' } };
const USES_FOREIGN = `
  import { Foreign } from 'dependency';
  export class Klass {
    public foreign(): Foreign {
      return new Foreign();
    }
  }
`;

describe('dependencyClosure', () => {
  test('lists the dependencies that have targets', () =>
    TestWorkspace.withWorkspace((ws) => {
      ws.addDependency(compileJsiiForTest(DEPENDENCY_SOURCE, { packageJson: { name: 'dependency' } }));

      const result = compileJsiiForTest(USES_FOREIGN, {
        compilationDirectory: ws.rootDirectory,
        packageJson: DEPENDS_ON_IT,
      });

      expect(result.assembly.dependencies).toEqual({ dependency: '*' });
      expect(result.assembly.dependencyClosure).toEqual({ dependency: { targets: { js: { npm: 'dependency' } } } });
    }));

  test('leaves out a dependency that has no targets', () =>
    TestWorkspace.withWorkspace((ws) => {
      ws.addDependency(compileJsiiForTest(DEPENDENCY_SOURCE, { packageJson: { name: 'dependency' } }));
      updateAssembly(ws.dependencyDir('dependency'), (assembly) => delete assembly.targets);

      const result = compileJsiiForTest(USES_FOREIGN, {
        compilationDirectory: ws.rootDirectory,
        packageJson: DEPENDS_ON_IT,
      });

      expect(result.assembly.dependencies).toEqual({ dependency: '*' });
      expect(result.assembly.dependencyClosure).toBeUndefined();
    }));
});

describe('re-exporting a dependency', () => {
  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2951
  test.each([
    { statement: "export * from 'dependency';", copiedFqn: 'testpkg.Foreign' },
    { statement: "export * as dep from 'dependency';", copiedFqn: 'testpkg.dep.Foreign' },
  ])('"$statement" copies the dependency types into the assembly', ({ statement, copiedFqn }) =>
    TestWorkspace.withWorkspace((ws) => {
      ws.addDependency(compileJsiiForTest(DEPENDENCY_SOURCE, { packageJson: { name: 'dependency' } }));

      const result = compileJsiiForTest(`${statement}\n${USES_FOREIGN}`, {
        compilationDirectory: ws.rootDirectory,
        packageJson: DEPENDS_ON_IT,
      });

      // References to the type still point at the dependency...
      const klass = result.assembly.types!['testpkg.Klass'] as spec.ClassType;
      expect(klass.methods).toEqual([
        expect.objectContaining({ name: 'foreign', returns: { type: { fqn: 'dependency.Foreign' } } }),
      ]);
      // ...but the dependency's type is also declared again, as part of this assembly.
      expect(Object.keys(result.assembly.types!).sort()).toEqual([copiedFqn, 'testpkg.Klass'].sort());
      expect(result.assembly.types![copiedFqn]).toMatchObject({
        assembly: 'testpkg',
        name: 'Foreign',
        locationInModule: { filename: 'node_modules/dependency/index.d.ts' },
      });
      // No submodule is declared for the namespace export.
      expect(result.assembly.submodules).toBeUndefined();
    }),
  );
});

function updateAssembly(packageDir: string, update: (assembly: spec.Assembly) => void) {
  const file = path.join(packageDir, spec.SPEC_FILE_NAME);
  const assembly: spec.Assembly = JSON.parse(fs.readFileSync(file, 'utf-8'));
  update(assembly);
  fs.writeFileSync(file, JSON.stringify(assembly), 'utf-8');
}
