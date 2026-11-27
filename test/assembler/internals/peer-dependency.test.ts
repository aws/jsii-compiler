import { compileJsiiForTest, TestWorkspace } from '../../../src/helpers';

// JSII0005 at the declaration of a dependency's class or enum, which the behavior tests do not reach.
describe('JSII0005 (missing peer dependency)', () => {
  const DEPENDENCY_SOURCE = `
    export class Foreign {
      public hello(): number {
        return 1;
      }
    }
    export enum Color { RED = 'red' }
  `;

  const locations = (peerDependencies?: { [name: string]: string }) =>
    TestWorkspace.withWorkspace((ws) => {
      ws.addDependency(compileJsiiForTest(DEPENDENCY_SOURCE, { packageJson: { name: 'dependency' } }));
      const result = compileJsiiForTest(
        `
          import { Color, Foreign } from 'dependency';
          export class Klass {
            public readonly color: Color = Color.RED;
            public foreign(): Foreign {
              return new Foreign();
            }
          }
        `,
        {
          compilationDirectory: ws.rootDirectory,
          packageJson: { dependencies: { dependency: '*' }, peerDependencies },
          captureDiagnostics: true,
        },
      );
      return result.diagnostics
        .filter((d) => (d as { jsiiCode?: number }).jsiiCode === 5)
        .map((d) => `${d.file?.fileName.replace(/.*node_modules\//, '') ?? '<none>'} ${d.messageText}`);
    });

  test('is reported at the declaration in the dependency, and with no location', () => {
    expect(locations()).toEqual([
      expect.stringMatching(/^<none> The type "dependency.Color" is exposed/),
      expect.stringMatching(/^<none> The type "dependency.Foreign" is exposed/),
      expect.stringMatching(/^dependency\/index.d.ts The type "dependency.Foreign" is exposed/),
      expect.stringMatching(/^dependency\/index.d.ts The type "dependency.Color" is exposed/),
    ]);
  });

  test('is not reported for a peer dependency', () => {
    expect(locations({ dependency: '*' })).toEqual([]);
  });
});
