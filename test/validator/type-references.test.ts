import * as fs from 'node:fs';
import * as path from 'node:path';
import * as spec from '@jsii/spec';
import { DiagnosticCategory } from 'typescript';

import { compileJsiiForTest, TestWorkspace } from '../../src/helpers';
import { compileJsiiForDiagnostics } from '../compiler-helpers';

describe('JSII9001 type not found in the corresponding assembly', () => {
  // The assembler resolves types of a submodule from the submodules the dependency declares, without looking at the
  // dependency's types. So when the .jsii file lists the submodule but not the type, only the validator notices.
  // @TODO(ts7): the TypeScript 7 assembler resolves the type from the dependency's types, and reports JSII3002 and
  // JSII9002 for `dependency.Foreign` instead of JSII9001
  test.skip('is reported when a dependency declares a submodule, but not the type that is used from it', () =>
    TestWorkspace.withWorkspace((ws) => {
      ws.addDependency(
        compileJsiiForTest(
          { 'index.ts': 'export * as sub from "./sub"', 'sub.ts': 'export class Foreign {}' },
          { packageJson: { name: 'dependency' } },
        ),
      );
      removeType(ws.dependencyDir('dependency'), 'dependency.sub.Foreign');

      const diagnostics = compileJsiiForDiagnostics(
        `
        import { sub } from 'dependency';
        export class Klass {
          public foreign(): sub.Foreign {
            throw new Error('not implemented');
          }
        }
        `,
        {
          compilationDirectory: ws.rootDirectory,
          packageJson: { dependencies: { dependency: '*' }, peerDependencies: { dependency: '*' } },
        },
      );

      expect(
        diagnostics
          .filter((d) => d.category === DiagnosticCategory.Error)
          .map((d) => ({ code: d.jsiiCode, message: d.messageText })),
      ).toEqual([{ code: 9001, message: 'Type not found in the corresponding assembly: "dependency.sub.Foreign"' }]);
    }));

  // @TODO(ts7): the TypeScript 7 assembler resolves the type from the dependency's types, and reports JSII3002 and
  // JSII9002 for `dependency.Foreign` instead of JSII9001
  test.skip('is reported when the assembly of the dependency has no types at all', () =>
    TestWorkspace.withWorkspace((ws) => {
      ws.addDependency(
        compileJsiiForTest(
          { 'index.ts': 'export * as sub from "./sub"', 'sub.ts': 'export class Foreign {}' },
          { packageJson: { name: 'dependency' } },
        ),
      );
      // "types" is optional in the assembly schema.
      editAssembly(ws.dependencyDir('dependency'), (assembly) => delete assembly.types);

      const diagnostics = compileJsiiForDiagnostics(
        `
        import { sub } from 'dependency';
        export class Klass {
          public foreign(): sub.Foreign {
            throw new Error('not implemented');
          }
        }
        `,
        {
          compilationDirectory: ws.rootDirectory,
          packageJson: { dependencies: { dependency: '*' }, peerDependencies: { dependency: '*' } },
        },
      );

      expect(
        diagnostics
          .filter((d) => d.category === DiagnosticCategory.Error)
          .map((d) => ({ code: d.jsiiCode, message: d.messageText })),
      ).toEqual([{ code: 9001, message: 'Type not found in the corresponding assembly: "dependency.sub.Foreign"' }]);
    }));
});

function removeType(packageDir: string, fqn: string) {
  editAssembly(packageDir, (assembly) => delete assembly.types![fqn]);
}

function editAssembly(packageDir: string, edit: (assembly: spec.Assembly) => void) {
  const file = path.join(packageDir, spec.SPEC_FILE_NAME);
  const assembly: spec.Assembly = JSON.parse(fs.readFileSync(file, 'utf-8'));
  edit(assembly);
  fs.writeFileSync(file, JSON.stringify(assembly), 'utf-8');
}
