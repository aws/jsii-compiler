import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';

import { TestWorkspace, compileJsiiForTest } from '../../src/helpers';
import { JsiiDiagnostic } from '../../src/jsii-diagnostic';
import { compileJsiiForDiagnostics } from '../compiler-helpers';

/**
 * Where a "see also" note of a diagnostic points: the file, the (1-based) line, and the text found at that position.
 */
function notesOf(diagnostics: readonly JsiiDiagnostic[], code: number) {
  const [diagnostic, ...others] = diagnostics.filter((d) => d.jsiiCode === code);
  expect(diagnostic).toBeDefined();
  expect(others).toEqual([]);

  return diagnostic.relatedInformation.map((info) => ({
    message: info.messageText,
    file: path.basename(info.file!.fileName),
    line: ts.getLineAndCharacterOfPosition(info.file!, info.start!).line + 1,
    text: info.file!.text.slice(info.start!, info.start! + info.length!),
  }));
}

// The notes of JSII1004, JSII1005, JSII3001, JSII3003, JSII3999, JSII5002 to JSII5004, JSII5006, JSII5008 to JSII5011,
// JSII5019 to JSII5021 and JSII7001 are covered by the snapshots of test/negatives.test.ts.

describe('JSII3002 type-model/unexported-foreign-type', () => {
  test('points to the declaration of the type in the dependency', () =>
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

      expect(notesOf(diagnostics, 3002)).toEqual([
        {
          message: 'The referenced type is declared here',
          file: 'index.d.ts',
          line: 4,
          text: 'export declare class Hidden {}',
        },
      ]);
    }));
});

describe('JSII3004 type-model/invalid-supertype', () => {
  test('points to the declaration of the invalid super type', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      type Alias = { readonly y: string };
      export interface IBad extends Alias {
        readonly z: string;
      }
    `);

    expect(notesOf(diagnostics, 3004)).toEqual([
      {
        message: 'The invalid super type is declared here.',
        file: 'index.ts',
        line: 2,
        text: '{ readonly y: string }',
      },
    ]);
  });

  test('has no note when the invalid super type is declared by the TypeScript library', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export interface Base {
        readonly foo: string;
      }
      export interface Derived extends Partial<Base> {
        readonly baz: number;
      }
    `);

    expect(notesOf(diagnostics, 3004)).toEqual([]);
  });
});

describe('JSII5005 language-compatibility/override-changes-param-count', () => {
  test('points to the method that is overridden', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export class Base {
        public method(a: string) {
          return a;
        }
      }
      export class Derived extends Base {
        public method(a: string, b: string) {
          return a + b;
        }
      }
    `);

    expect(notesOf(diagnostics, 5005)).toEqual([
      { message: 'The implemented declaration is here.', file: 'index.ts', line: 3, text: 'method' },
    ]);
  });
});

describe('JSII5007 language-compatibility/override-changes-variadic', () => {
  test('points to the variadic parameter that is overridden', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export class Base {
        public method(...items: string[]) {
          return items;
        }
      }
      export class Derived extends Base {
        public method(items: string[]) {
          return items;
        }
      }
    `);

    expect(notesOf(diagnostics, 5007)).toEqual([
      { message: 'The implemented declaration is here.', file: 'index.ts', line: 3, text: '...' },
    ]);
  });
});

describe('JSII9003 miscellaneous/unresolveable-module', () => {
  let externalDir: string;

  beforeEach(() => {
    // A directory that is not inside any package (no package.json in any parent).
    externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsii-external-'));
    fs.writeFileSync(path.join(externalDir, 'external.d.ts'), 'export declare class External {}');
  });

  afterEach(() => {
    fs.rmSync(externalDir, { recursive: true, force: true });
  });

  test('points to the declaration of the type outside of any package', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      import { External } from '${externalDir}/external';
      export class Klass {
        public method(): External {
          return null as any;
        }
      }
    `);

    expect(notesOf(diagnostics, 9003)).toEqual([
      {
        message: 'The referenced type is declared here',
        file: 'external.d.ts',
        line: 1,
        text: 'export declare class External {}',
      },
    ]);
  });
});
