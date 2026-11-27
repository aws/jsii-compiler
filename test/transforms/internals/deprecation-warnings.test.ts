import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as spec from '@jsii/spec';

import { CompilerHost, loadTypeScriptApi } from '../../../src/compiler-host';
import { ProjectInfo } from '../../../src/project-info';
import { DeprecationWarningsInjector, WARNINGSCODE_FILE_NAME } from '../../../src/transforms/deprecation-warnings';

/**
 * The `DeprecationWarningsInjector` relies on invariants that the assembler guarantees. These tests call it directly
 * with assemblies that break those invariants.
 */

let projectRoot: string;
let host: CompilerHost | undefined;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jsii-deprecation-warnings-internals-'));
});

afterEach(() => {
  host?.close();
  host = undefined;
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('validators', () => {
  test.each([
    ['property', { properties: [{ name: 'missing', type: { fqn: 'test.Missing' } }] }],
    ['super-interface', { interfaces: ['test.Missing'] }],
  ])('cannot be rendered when a %s is not found in the assembly', (_, members) => {
    const injector = new DeprecationWarningsInjector(loadTypeScriptApi(), undefined as any, new Map());
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
  // them), so the assembly is built by hand here. The member declarations come from a TypeScript 7 project, the way
  // the assembler hands them over (`Assembler.enumMemberDeclarations`).
  test('deprecated members sharing their value with a non-deprecated member produce no warning', () => {
    fs.writeFileSync(path.join(projectRoot, 'index.ts'), 'export enum State { ON = 1, LEGACY_ON = 1, OFF = 2 }');
    fs.writeFileSync(path.join(projectRoot, 'tsconfig.json'), JSON.stringify({ files: ['index.ts'] }));
    host = CompilerHost.open(projectRoot);
    const project = host.getProject();
    const { SyntaxKind } = host.ts;
    const enumDecl = project.program
      .getSourceFile(path.join(projectRoot, 'index.ts'))
      .statements.find((s: any) => s.kind === SyntaxKind.EnumDeclaration);
    const members = new Map<string, any>(enumDecl.members.map((m: any) => [m.name.text, { resolve: () => m }]));

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

    new DeprecationWarningsInjector(host.ts, project, new Map([['test.State', members]])).process(assembly, {
      projectRoot,
      dependencyClosure: [],
    } as unknown as ProjectInfo);

    const warnings = fs.readFileSync(path.join(projectRoot, WARNINGSCODE_FILE_NAME), 'utf-8');
    expect(warnings).toContain('print("test.State#OFF", "Do not turn off")');
    expect(warnings).not.toContain('test.State#LEGACY_ON');
  });
});
