import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as spec from '@jsii/spec';
import * as ts from 'typescript';

import { compileJsiiForTest } from '../../src';
import { ProjectInfo } from '../../src/project-info';
import { DeprecationWarningsInjector, WARNINGSCODE_FILE_NAME } from '../../src/transforms/deprecation-warnings';
import { TypeTracker } from '../../src/type-tracker';

/**
 * The `DeprecationWarningsInjector` relies on invariants that the assembler guarantees. These tests exercise the
 * branches that deal with inputs that break those invariants, or that depend on the host platform.
 */

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jsii-deprecation-warnings-guards-'));
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('validators', () => {
  test('are always rendered for types of another assembly', () => {
    const injector = new DeprecationWarningsInjector(undefined as any, new TypeTracker());
    const foreignType: spec.Type = {
      assembly: 'other',
      fqn: 'other.Foreign',
      kind: spec.TypeKind.Interface,
      name: 'Foreign',
    };

    // Callers skip foreign types themselves (see `findType2`), so this can only be reached by calling it directly.
    expect((injector as any).shouldRenderValidator(foreignType, { name: 'test' })).toBe(true);
  });

  test.each([
    [
      'property',
      {
        properties: [{ name: 'missing', type: { fqn: 'test.Missing' } }],
      },
    ],
    ['super-interface', { interfaces: ['test.Missing'] }],
  ])('cannot be rendered when a %s is not found in the assembly', (_, members) => {
    const injector = new DeprecationWarningsInjector(undefined as any, new TypeTracker());
    const assembly = {
      name: 'test',
      types: {
        'test.Props': {
          assembly: 'test',
          datatype: true,
          fqn: 'test.Props',
          kind: spec.TypeKind.Interface,
          name: 'Props',
          ...members,
        },
      },
    } as unknown as spec.Assembly;

    expect(() => injector.process(assembly, { projectRoot } as ProjectInfo)).toThrow(
      'Could not find type in same assembly: test.Missing',
    );
  });
});

describe('enums', () => {
  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2961
  //
  // The assembler can currently not produce an enum where two members have the same value (it silently drops one of
  // them), so the assembly is built by hand here.
  test('deprecated members sharing their value with a non-deprecated member produce no warning', () => {
    const file = path.join(projectRoot, 'index.ts');
    fs.writeFileSync(file, 'export enum State { ON = 1, LEGACY_ON = 1, OFF = 2 }');
    const program = ts.createProgram([file], { noLib: true });
    const typeTracker = new TypeTracker();
    typeTracker.registerEnum('test.State', program.getSourceFile(file)!.statements.find(ts.isEnumDeclaration)!);

    const deprecatedDocs = (deprecated: string) => ({ stability: spec.Stability.Deprecated, deprecated });
    const assembly = {
      name: 'test',
      types: {
        'test.State': {
          assembly: 'test',
          fqn: 'test.State',
          kind: spec.TypeKind.Enum,
          locationInModule: { filename: 'index.ts', line: 1 },
          members: [
            { name: 'ON' },
            { name: 'LEGACY_ON', docs: deprecatedDocs('Use ON') },
            { name: 'OFF', docs: deprecatedDocs('Do not turn off') },
          ],
          name: 'State',
        },
      },
    } as unknown as spec.Assembly;

    new DeprecationWarningsInjector(program.getTypeChecker(), typeTracker).process(assembly, {
      projectRoot,
    } as ProjectInfo);

    const warnings = fs.readFileSync(path.join(projectRoot, WARNINGSCODE_FILE_NAME), 'utf-8');
    expect(warnings).toContain('print("test.State#OFF", "Do not turn off")');
    expect(warnings).not.toContain('test.State#LEGACY_ON');
  });
});

describe('on Windows', () => {
  test('require paths of the warnings file always use forward slashes', () => {
    // Simulate a platform where `path.relative` produces backslashes, as it does on Windows.
    // (`import * as path` creates a copy of the module, but the code under test sees changes made to the real one)
    const realPath = jest.requireActual<typeof path>('node:path');
    const relative = realPath.relative;
    const sep = jest.replaceProperty(realPath, 'sep', '\\');
    jest.spyOn(realPath, 'relative').mockImplementation((from, to) => {
      const result = relative(from, to);
      return result.startsWith('..') ? result.replace(/\//g, '\\') : result;
    });

    const compile = () =>
      compileJsiiForTest(
        {
          'index.ts': "export * from './some/folder/source'",
          'some/folder/source.ts': `
            export class Foo {
              /** @deprecated Use something else */
              public bar(){}
            }
          `,
        },
        undefined /* callback */,
        { addDeprecationWarnings: true },
      );

    let result: ReturnType<typeof compile>;
    try {
      result = compile();
    } finally {
      sep.restore();
    }

    expect(result.files['some/folder/source.js']).toContain(
      'const jsiiDeprecationWarnings = require("../../.warnings.jsii.js")',
    );
  }, 60000);
});
