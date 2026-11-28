import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as spec from '@jsii/spec';
import * as ts from 'typescript';

import { ProjectInfo } from '../../../src/project-info';
import { DeprecationWarningsInjector, WARNINGSCODE_FILE_NAME } from '../../../src/transforms/deprecation-warnings';
import { TypeTracker } from '../../../src/type-tracker';

/**
 * The `DeprecationWarningsInjector` relies on invariants that the assembler guarantees. These tests call it directly
 * with assemblies that break those invariants.
 */

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jsii-deprecation-warnings-internals-'));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('validators', () => {
  test.each([
    ['property', { properties: [{ name: 'missing', type: { fqn: 'test.Missing' } }] }],
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
  // The assembler rejects an enum where two members have the same value (JSII1004), so the assembly is built by hand
  // here.
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
