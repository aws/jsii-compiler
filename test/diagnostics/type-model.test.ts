import * as fs from 'node:fs';
import * as path from 'node:path';

import { TestWorkspace, compileJsiiForTest } from '../../src/helpers';
import { compileJsiiForDiagnostics } from '../compiler-helpers';

describe('JSII3002 type-model/unexported-foreign-type', () => {
  // @TODO(ts7): expects a jsii validation diagnostic (JSII3002/JSII3006); re-enable with the port of the validator
  test.skip('is reported when a type from a dependency is not part of its assembly', () =>
    TestWorkspace.withWorkspace((ws) => {
      ws.addDependency(compileJsiiForTest('export class Exported {}', { packageJson: { name: 'dependency' } }));

      // Add a type to the dependency's declarations that is absent from its jsii assembly.
      const dependencyDir = ws.dependencyDir('dependency');
      fs.appendFileSync(path.join(dependencyDir, 'index.d.ts'), '\nexport declare class Hidden {}\n');
      fs.appendFileSync(path.join(dependencyDir, 'index.js'), '\nexports.Hidden = class Hidden {};\n');

      const diagnostics = compileJsiiForDiagnostics(
        `
          import { Hidden } from 'dependency';
          export class Klass {
            public method(): Hidden {
              return new Hidden();
            }
          }
        `,
        {
          compilationDirectory: ws.rootDirectory,
          packageJson: { dependencies: { dependency: '*' }, peerDependencies: { dependency: '*' } },
        },
      );

      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          jsiiCode: 3002,
          messageText:
            'Type "dependency.Hidden" cannot be used as a return type because it is not exported from dependency',
        }),
      );
    }));
});

describe('JSII3006 type-model/type-used-as-class', () => {
  // @TODO(ts7): expects a jsii validation diagnostic (JSII3002/JSII3006); re-enable with the port of the validator
  test.skip('is reported when a class extends a non-class type', () => {
    const diagnostics = compileJsiiForDiagnostics('export class Klass extends Array<string> {}');

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 3006,
        messageText: 'Type "array<string>" cannot be used as a class',
      }),
    );
  });
});
