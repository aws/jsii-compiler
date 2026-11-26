import { DiagnosticCategory } from 'typescript';

import { compileJsiiForTest, TestWorkspace } from '../lib';

const DEPRECATED = '/** @deprecated stripped */';

function strip(source: Parameters<typeof compileJsiiForTest>[0]) {
  return compileJsiiForTest(source, undefined /* callback */, { stripDeprecated: true });
}

function declarations(result: ReturnType<typeof strip>, file = 'index.d.ts') {
  return result.files[file];
}

describe('deprecated interfaces in the inheritance chain', () => {
  test('are replaced by the interfaces they extend', () => {
    const result = strip(`
      export interface IBase {}
      ${DEPRECATED}
      export interface IMid extends IBase {}
      export interface ILeaf extends IMid {}
      export class Impl implements IMid {}
      export class ImplBoth implements IMid, IBase {}
    `);

    expect(Object.keys(result.assembly.types!).sort()).toEqual([
      'testpkg.IBase',
      'testpkg.ILeaf',
      'testpkg.Impl',
      'testpkg.ImplBoth',
    ]);
    expect(result.assembly.types!['testpkg.ILeaf']).toHaveProperty('interfaces', ['testpkg.IBase']);
    expect(result.assembly.types!['testpkg.Impl']).toHaveProperty('interfaces', ['testpkg.IBase']);
    expect(result.assembly.types!['testpkg.ImplBoth']).toHaveProperty('interfaces', ['testpkg.IBase']);

    expect(declarations(result)).toMatchInlineSnapshot(`
      "export interface IBase {
      }
      export interface ILeaf extends IBase {
      }
      export declare class Impl implements IBase {
      }
      export declare class ImplBoth implements IBase {
      }
      "
    `);
  });

  test('are replaced while preserving the other interfaces that were already declared', () => {
    const result = strip(`
      export interface IA {}
      export interface IB {}
      ${DEPRECATED}
      export interface IMid extends IA {}
      export interface ILeaf extends IMid, IB {}
      export class Impl implements IMid, IB {}
      export class SubImpl extends Impl implements IMid {}
    `);

    expect(result.assembly.types!['testpkg.ILeaf']).toHaveProperty('interfaces', ['testpkg.IA', 'testpkg.IB']);
    expect(result.assembly.types!['testpkg.Impl']).toHaveProperty('interfaces', ['testpkg.IA', 'testpkg.IB']);
    expect(result.assembly.types!['testpkg.SubImpl']).toHaveProperty('interfaces', ['testpkg.IA']);

    expect(declarations(result)).toMatchInlineSnapshot(`
      "export interface IA {
      }
      export interface IB {
      }
      export interface ILeaf extends IB, IA {
      }
      export declare class Impl implements IB, IA {
      }
      export declare class SubImpl extends Impl implements IA {
      }
      "
    `);
  });

  test('are removed when they do not extend anything', () => {
    const result = strip(`
      ${DEPRECATED}
      export interface IMid {}
      export interface ILeaf extends IMid {}
      export class Impl implements IMid {}
    `);

    expect(result.assembly.types!['testpkg.ILeaf']).not.toHaveProperty('interfaces');
    expect(result.assembly.types!['testpkg.Impl']).not.toHaveProperty('interfaces');

    expect(declarations(result)).toMatchInlineSnapshot(`
      "export interface ILeaf {
      }
      export declare class Impl {
      }
      "
    `);
  });

  test('imports of the deprecated type are removed while other named imports are kept', () => {
    const result = strip({
      'index.ts': `
        export * from './types';
        export * from './impl';
      `,
      'types.ts': `
        export interface IKeep {}
        ${DEPRECATED}
        export interface IDeprecated {}
      `,
      'impl.ts': `
        import { IKeep, IDeprecated } from './types';
        export class Impl implements IKeep, IDeprecated {}
      `,
    });

    expect(declarations(result, 'impl.d.ts')).toMatchInlineSnapshot(`
      "import { IKeep } from './types';
      export declare class Impl implements IKeep {
      }
      "
    `);
  });
});

describe('deprecated classes in the inheritance chain', () => {
  test('are replaced by their base class', () => {
    const result = strip(`
      export class Base {}
      ${DEPRECATED}
      export class Mid extends Base {}
      export class Leaf extends Mid {}
    `);

    expect(result.assembly.types!['testpkg.Leaf']).toHaveProperty('base', 'testpkg.Base');
    expect(declarations(result)).toMatchInlineSnapshot(`
      "export declare class Base {
      }
      export declare class Leaf extends Base {
      }
      "
    `);
  });

  test('are removed when they have no base class', () => {
    const result = strip(`
      ${DEPRECATED}
      export class Mid {}
      export class Leaf extends Mid {}
    `);

    expect(result.assembly.types!['testpkg.Leaf']).not.toHaveProperty('base');
    expect(declarations(result)).toMatchInlineSnapshot(`
      "export declare class Leaf {
      }
      "
    `);
  });

  describe('that extend types from a dependency', () => {
    function compileWithDependency(callback: (consumer: ReturnType<typeof strip>) => void) {
      TestWorkspace.withWorkspace((ws) => {
        ws.addDependency(
          compileJsiiForTest(
            `
              export class ForeignBase {}
              export interface IForeign {}
            `,
            { packageJson: { name: 'foreign' } },
          ),
        );
        const consumer = compileJsiiForTest(
          `
            import { ForeignBase, IForeign } from 'foreign';
            ${DEPRECATED}
            export class Old extends ForeignBase implements IForeign {}
            export class Leaf extends Old {}
            export class OnlyInterface implements IForeign {}
          `,
          { compilationDirectory: ws.rootDirectory, packageJson: { dependencies: { foreign: '0.0.1' } } },
          { stripDeprecated: true },
        );
        callback(consumer);
      });
    }

    test('are replaced by the types from the dependency in the assembly', () => {
      compileWithDependency((consumer) => {
        expect(Object.keys(consumer.assembly.types!).sort()).toEqual(['testpkg.Leaf', 'testpkg.OnlyInterface']);
        expect(consumer.assembly.types!['testpkg.Leaf']).toHaveProperty('base', 'foreign.ForeignBase');
        expect(consumer.assembly.types!['testpkg.Leaf']).toHaveProperty('interfaces', ['foreign.IForeign']);
      });
    });

    test('get a synthetic import for the interface from the dependency', () => {
      compileWithDependency((consumer) => {
        const dts = declarations(consumer);
        expect(dts).toContain('import * as foreign_1 from "foreign";');
        expect(dts).toContain('implements foreign_1.IForeign');
      });
    });

    // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2957
    // The synthetic import for the replaced base class is never emitted, so "foreign_2" is undeclared.
    test('do not get a synthetic import for the base class from the dependency', () => {
      compileWithDependency((consumer) => {
        const dts = declarations(consumer);
        expect(dts).toContain('export declare class Leaf extends foreign_2.ForeignBase');
        expect(dts).not.toContain('import * as foreign_2');
      });
    });
  });
});

describe('leftover usage of deprecated types', () => {
  function leftoverDiagnostics(source: string) {
    const result = compileJsiiForTest(source, { captureDiagnostics: true }, { stripDeprecated: true });
    return result.diagnostics.filter(
      (d) => d.category === DiagnosticCategory.Error && `${d.messageText}`.includes('erased by --strip-deprecated'),
    );
  }

  const PRELUDE = `
    ${DEPRECATED}
    export interface IOld {}
    export interface IOther {}
  `;

  test.each([
    ['method return type', 'public method(): IOld { return {} as any; }', 'Method'],
    ['method parameter', 'public method(x: IOld) { Array.isArray(x); }', 'Parameter'],
    ['constructor parameter', 'public constructor(x: IOld) { Array.isArray(x); }', 'Parameter'],
    ['property', 'public readonly prop?: IOld;', 'Property'],
    ['array element', 'public readonly prop?: IOld[];', 'Property'],
    ['map element', 'public readonly prop?: { [key: string]: IOld };', 'Property'],
    ['union member in a parameter', 'public method(x: string | IOld) { Array.isArray(x); }', 'Parameter'],
    ['union member in a return type', 'public method(): IOld | string { return ""; }', 'Method'],
    ['intersection member', 'public method(x: IOther & IOld) { Array.isArray(x); }', 'Parameter'],
  ])('%s', (_, member, expectedPrefix) => {
    const diagnostics = leftoverDiagnostics(`
      ${PRELUDE}
      export class Klass {
        ${member}
      }
    `);

    expect(diagnostics.map((d) => `${d.messageText}`)).toContain(
      `${expectedPrefix} has @deprecated type testpkg.IOld, and it is erased by --strip-deprecated.`,
    );
  });

  test('refers to the declaration of the deprecated type', () => {
    const [diagnostic] = leftoverDiagnostics(`
      ${PRELUDE}
      export class Klass {
        public method(x: IOld) { Array.isArray(x); }
      }
    `);

    expect(diagnostic.relatedInformation?.map((info) => info.messageText)).toEqual([
      'The @deprecated type is declared here',
    ]);
  });

  test('is not reported for primitives, or for types that are not deprecated', () => {
    const diagnostics = leftoverDiagnostics(`
      ${PRELUDE}
      export class Klass {
        public method(x: string, y: IOther): number { Array.isArray(y); return x.length; }
        public readonly prop?: string | IOther;
      }
    `);

    expect(diagnostics).toEqual([]);
  });
});
