import * as fs from 'node:fs';
import * as path from 'node:path';
import * as spec from '@jsii/spec';
import * as ts from 'typescript';

import { Assembler } from '../../src/assembler';
import { compileJsiiForTest, TestWorkspace } from '../../src/helpers';
import { JsiiDiagnostic } from '../../src/jsii-diagnostic';
import { DeprecatedRemover } from '../../src/transforms/deprecated-remover';

// These tests exercise the defensive branches of the assembler: situations that the TypeScript compiler (or an earlier
// step of the assembler) normally rules out. Where no source code can produce the situation, the test patches the
// TypeScript objects the assembler reads, and says so.

afterEach(() => jest.restoreAllMocks());

describe('exported symbols without a declaration', () => {
  test('are skipped in modules, submodules, namespaces and nested types', () => {
    const ghosts = new Array<ts.Symbol>();
    patchTypeChecker((checker) => ({
      // Every module (the entry point, the submodule, the namespace and the class/namespace merge) gets one more
      // export, which has neither a value declaration nor any declaration.
      getExportsOfModule: (moduleSymbol: ts.Symbol) => {
        const ghost = makeGhostSymbol(`ghost${ghosts.length}`);
        ghosts.push(ghost);
        return [...checker.getExportsOfModule(moduleSymbol), ghost];
      },
    }));

    const result = compileJsiiForTest({
      'index.ts': `
        export * as sub from './sub';
        export namespace ns {
          export class Inner {}
        }
        export class Merged {}
        export namespace Merged {
          export class Nested {}
        }
      `,
      'sub.ts': 'export class Sub {}',
    });

    expect(ghosts.length).toBeGreaterThan(0);
    expect(Object.keys(result.assembly.types ?? {}).sort()).toEqual([
      'testpkg.Merged',
      'testpkg.Merged.Nested',
      'testpkg.ns.Inner',
      'testpkg.sub.Sub',
    ]);
  });

  test('JSII3003 is reported without a location when such a symbol is exported by two submodules', () => {
    const ghost = makeGhostSymbol('ghost');
    patchTypeChecker((checker) => ({
      getExportsOfModule: (moduleSymbol: ts.Symbol) => [...checker.getExportsOfModule(moduleSymbol), ghost],
    }));

    const result = compileJsiiForTest(
      {
        'index.ts': `
          export * as one from './one';
          export * as two from './two';
        `,
        'one.ts': 'export class One {}',
        'two.ts': 'export class Two {}',
      },
      { captureDiagnostics: true },
    );

    const jsii3003 = result.diagnostics.filter((d) => JsiiDiagnostic.isJsiiDiagnostic(d) && d.jsiiCode === 3003);
    expect(jsii3003.map((d) => [d.file, flatten(d)])).toEqual([
      [undefined, 'Symbol is exported under two distinct submodules: one and two'],
    ]);
  });
});

describe('deprecation warnings', () => {
  test('metadata is created when the assembly has none', () => {
    // The assembly always has metadata when it reaches this point. Removing it in the (mocked) deprecated remover
    // simulates a transform that drops it.
    jest.spyOn(DeprecatedRemover.prototype, 'removeFrom').mockImplementation((assembly: spec.Assembly) => {
      delete assembly.metadata;
      return [];
    });

    const result = compileJsiiForTest('export class Foo {}', undefined, {
      stripDeprecated: true,
      addDeprecationWarnings: true,
    });

    expect(result.assembly.metadata).toEqual({ jsii: { compiledWithDeprecationWarnings: true } });
  });
});

describe('dependency closure', () => {
  test('a dependency that TypeScript cannot resolve is ignored when registering submodules', () =>
    TestWorkspace.withWorkspace((ws) => {
      ws.addDependency(compileJsiiForTest('export class Foreign {}', { packageJson: { name: 'dependency' } }));
      // Leave the dependency with an entry point that Node.js finds, but TypeScript does not understand, and no typings.
      const depDir = ws.dependencyDir('dependency');
      const packageJson = JSON.parse(fs.readFileSync(path.join(depDir, 'package.json'), 'utf-8'));
      delete packageJson.types;
      packageJson.main = 'entry.txt';
      fs.writeFileSync(path.join(depDir, 'package.json'), JSON.stringify(packageJson));
      fs.writeFileSync(path.join(depDir, 'entry.txt'), '');
      fs.rmSync(path.join(depDir, 'index.d.ts'));
      fs.rmSync(path.join(depDir, 'index.js'));

      const result = compileJsiiForTest('export class Klass {}', {
        compilationDirectory: ws.rootDirectory,
        packageJson: { dependencies: { dependency: '*' }, peerDependencies: { dependency: '*' } },
      });

      expect(Object.keys(result.assembly.types ?? {})).toEqual(['testpkg.Klass']);
      expect(result.assembly.dependencyClosure).toEqual({ dependency: { targets: { js: { npm: 'dependency' } } } });
    }));
});

describe('base types', () => {
  test('an interface whose type reports no base types has no interfaces', () => {
    const getBaseTypes = typePrototype().getBaseTypes;
    jest.spyOn(typePrototype(), 'getBaseTypes').mockImplementation(function (this: ts.InterfaceType) {
      return this.symbol?.name === 'IChild' ? undefined : getBaseTypes.call(this);
    });

    const result = compileJsiiForTest(`
      export interface IParent { readonly parent: string }
      export interface IChild extends IParent { readonly child: string }
    `);

    expect(result.assembly.types?.['testpkg.IChild']).toMatchObject({ kind: 'interface', name: 'IChild' });
    expect(result.assembly.types?.['testpkg.IChild']).not.toHaveProperty('interfaces');
  });

  test('only the first base class is used when a class reports two of them', () => {
    // tsc rejects a second "extends", so the extra base class is added to what the type reports.
    const getBaseTypes = typePrototype().getBaseTypes;
    jest.spyOn(typePrototype(), 'getBaseTypes').mockImplementation(function (this: ts.InterfaceType) {
      const bases = getBaseTypes.call(this);
      if (this.symbol?.name !== 'Child' || bases == null) {
        return bases;
      }
      return [...bases, ...(getBaseTypes.call(bases[0] as ts.InterfaceType) ?? [])];
    });

    const result = compileJsiiForTest(`
      export class GrandParent {}
      export class Parent extends GrandParent {}
      export class Child extends Parent {}
    `);

    expect(result.assembly.types?.['testpkg.Child']).toMatchObject({ base: 'testpkg.Parent' });
  });

  test('JSII9998 is reported for a heritage clause that is neither "extends" nor "implements"', () => {
    patchAssembler((assembler) => {
      const classDecl = findDeclaration(assembler, 'Klass') as ts.ClassDeclaration;
      const original = classDecl.heritageClauses!;
      // There is no other kind of heritage clause in TypeScript; this one pretends to be one.
      const odd = Object.create(original[0], { token: { value: ts.SyntaxKind.ColonToken } });
      (classDecl as any).heritageClauses = ts.factory.createNodeArray([...original, odd]);
      return () => ((classDecl as any).heritageClauses = original);
    });

    expect(
      compileForDiagnostics(`
        export interface IFace { readonly prop: string }
        export class Klass implements IFace {
          public readonly prop = 'value';
        }
      `),
    ).toEqual(['JSII9998: Ignoring ColonToken heritage clause']);
  });

  test('a class whose type is not a class type fails with an internal error', () => {
    const isClass = typePrototype().isClass;
    jest.spyOn(typePrototype(), 'isClass').mockImplementation(function (this: ts.Type) {
      return this.symbol?.name === 'Klass' ? false : isClass.call(this);
    });

    expect(compileForDiagnostics('export class Klass {}')).toEqual([expect.stringMatching(/^JSII9997: .*Oh no/)]);
  });

  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2943
  test('JSII3999 is created for a class without a constructor whose base is not a class, then the compiler fails', () => {
    const jsii3999 = jest.spyOn(JsiiDiagnostic.JSII_3999_INCOHERENT_TYPE_MODEL, 'create');

    // The interface IOther adds an earlier deferred check, which moves the check of B's initializer ahead of the
    // check that throws.
    expect(
      compileForDiagnostics(`
        export interface I { readonly x: string }
        export interface IOther extends I { readonly y: string }
        declare const C: { new(): I };
        export class B extends C {}
      `),
    ).toEqual([expect.stringMatching(/^JSII9997: Unknown error: Oh no/)]);
    expect(jsii3999).toHaveBeenCalledWith(expect.anything(), 'Base type of testpkg.B (testpkg.I) is not a class');
  });
});

describe('members', () => {
  test('class members whose parent is not a declaration of the class are skipped', () => {
    const getDeclarations = symbolPrototype().getDeclarations;
    jest.spyOn(symbolPrototype(), 'getDeclarations').mockImplementation(function (this: ts.Symbol) {
      return this.name === 'Klass' ? [] : getDeclarations.call(this);
    });

    const result = compileJsiiForTest(`
      export class Klass {
        public readonly prop: string = 'value';
        public method(): void {}
      }
    `);

    expect(result.assembly.types?.['testpkg.Klass']).not.toHaveProperty('methods');
    expect(result.assembly.types?.['testpkg.Klass']).not.toHaveProperty('properties');
  });

  test('JSII9998 is reported for an interface member that is neither a method nor a property', () => {
    // An interface's properties never include its call signature; this adds it.
    const getProperties = typePrototype().getProperties;
    jest.spyOn(typePrototype(), 'getProperties').mockImplementation(function (this: ts.Type) {
      const properties = getProperties.call(this);
      const callSignature =
        this.symbol?.name === 'ICallable' ? this.symbol.members?.get(ts.InternalSymbolName.Call) : undefined;
      return callSignature ? [...properties, callSignature] : properties;
    });

    expect(
      compileForDiagnostics(`
        export interface ICallable {
          (): void;
          readonly name: string;
        }
      `),
    ).toEqual([
      'JSII9998: Unsupported CallSignature node. This declaration will not be accessible from other languages.',
    ]);
  });

  test('JSII9004 is reported when the signature of a method cannot be computed', () => {
    patchTypeChecker((checker) => ({
      getSignatureFromDeclaration: (decl: ts.SignatureDeclaration) =>
        ts.isMethodDeclaration(decl) ? undefined : checker.getSignatureFromDeclaration(decl),
    }));

    expect(
      compileForDiagnostics(`
        export class Klass {
          public method(): void {}
        }
      `),
    ).toEqual(['JSII9004: Unable to compute signature for method "method" of "testpkg.Klass"']);
  });
});

describe('interface member re-declarations', () => {
  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2970
  test('a property that changes its shape is accepted as identical, and the validator reports it instead of JSII5015', () => {
    expect(
      compileForDiagnostics(`
        export interface IA {
          readonly foo: string;
        }
        export interface IB extends IA {
          foo: string;
        }
      `),
    ).toEqual(['JSII5010: "testpkg.IB#foo" turns mutable when implementing testpkg.IA. Make it readonly']);
  });
});

describe('enums', () => {
  test('an enum whose declaration has no symbol fails with an internal error', () => {
    patchTypeChecker((checker) => ({
      getSymbolAtLocation: (node: ts.Node) =>
        ts.isIdentifier(node) && ts.isEnumDeclaration(node.parent) ? undefined : checker.getSymbolAtLocation(node),
    }));

    expect(compileForDiagnostics('export enum Color { RED, GREEN }')).toEqual([
      expect.stringMatching(/^JSII9997: Unknown error: Unable to resolve enum declaration for Color!/),
    ]);
  });
});

describe('type references', () => {
  test('JSII9997 is reported when the FQN of a referenced type cannot be determined', () => {
    // _getFQN always returns a name today; this pins the fallback in case it does not.
    jest.spyOn(Assembler.prototype as any, '_getFQN').mockReturnValue(undefined);
    const jsii9997 = jest.spyOn(JsiiDiagnostic.JSII_9997_UNKNOWN_ERROR, 'create');

    expect(
      compileForDiagnostics(`
        export class Other {}
        export class Klass {
          public readonly other: Other = new Other();
        }
      `),
    ).toEqual([
      // The empty FQN put in its place then fails a later check, which aborts the compilation.
      expect.stringMatching(/^JSII9997: Unknown error: Unknown type reference: {"fqn":""}/),
    ]);
    expect(jsii9997).toHaveBeenCalledWith(expect.anything(), new Error('Could not determine FQN'));
  });

  // Single-valued enums have enum literal types whose symbol is the member, not the enum; the assembler then looks
  // for the enum through the member's declaration. These give it an enum literal type whose symbol has declarations
  // that do not lead to an enum, so it keeps the type's own symbol.
  test.each([
    { case: 'no declaration', declarations: () => [] },
    {
      case: 'an enum member outside of an enum',
      declarations: (klass: ts.Declaration) => [fakeNode(ts.SyntaxKind.EnumMember, { parent: klass })],
    },
    {
      case: 'an enum member of an enum without a name',
      declarations: () => [
        fakeNode(ts.SyntaxKind.EnumMember, { parent: fakeNode(ts.SyntaxKind.EnumDeclaration, { name: undefined }) }),
      ],
    },
  ])('an enum literal type with $case resolves to its own symbol', ({ declarations }) => {
    let fqn: string | undefined;
    patchAssembler((assembler) => {
      assembler._defer('', [], () => {
        const klass = findDeclaration(assembler, 'Klass') as ts.ClassDeclaration;
        const symbol: ts.Symbol = assembler._typeChecker.getSymbolAtLocation(klass.name!);
        const original = symbol.declarations;
        symbol.declarations = declarations(klass);
        // With these declarations the symbol would look private (none of them is exported).
        assembler._isPrivateOrInternal = () => false;
        try {
          const enumLiteral = { flags: ts.TypeFlags.EnumLiteral, symbol };
          fqn = assembler._getFQN(enumLiteral, undefined, 'property type', false);
        } finally {
          symbol.declarations = original;
          delete assembler._isPrivateOrInternal;
        }
      });
    });

    compileJsiiForTest('export class Klass {}');

    expect(fqn).toBe('testpkg.Klass');
  });
});

describe('deferred checks', () => {
  test('a cycle between deferred checks fails with an internal error', () => {
    patchAssembler((assembler) => {
      assembler._defer('testpkg.A', ['testpkg.B'], () => undefined);
      assembler._defer('testpkg.B', ['testpkg.A'], () => undefined);
    });

    expect(compileForDiagnostics('export class Klass {}')).toEqual([
      expect.stringMatching(/^JSII9997: Unknown error: Could not invoke any more deferreds, cyclic dependency\?/),
    ]);
  });

  test.each([
    {
      reason: 'unresolvable',
      interfaces: ['testpkg.Missing'],
      error: 'Impossible to have unresolvable base in allInterfacesRecursively()',
    },
    {
      reason: 'not an interface',
      interfaces: ['testpkg.Klass'],
      error: 'Impossible to have non-interface base in allInterfacesRecursively()',
    },
  ])('collecting inherited properties fails when a base interface is $reason', ({ interfaces, error }) => {
    let thrown: unknown;
    patchAssembler((assembler) => {
      // Runs once all types are registered, like the checks that collect inherited properties.
      assembler._defer('', [], () => {
        try {
          assembler.allProperties({ fqn: 'testpkg.IFake', kind: spec.TypeKind.Interface, name: 'IFake', interfaces });
        } catch (e) {
          thrown = e;
        }
      });
    });

    compileJsiiForTest('export class Klass {}', { captureDiagnostics: true });

    expect(thrown).toEqual(new Error(error));
  });
});

/**
 * Runs `setup` with the assembler before it emits; the function `setup` returns, if any, runs after.
 */
function patchAssembler(setup: (assembler: any) => (() => void) | void) {
  const emit = Assembler.prototype.emit;
  jest.spyOn(Assembler.prototype, 'emit').mockImplementation(function (this: Assembler) {
    const teardown = setup(this);
    try {
      return emit.call(this);
    } finally {
      teardown?.();
    }
  });
}

/**
 * Replaces methods of the type checker the assembler uses with those `overrides` returns.
 */
function patchTypeChecker(overrides: (checker: ts.TypeChecker) => Partial<ts.TypeChecker>) {
  patchAssembler((assembler) => {
    const checker: ts.TypeChecker = assembler._typeChecker;
    const replaced: Record<PropertyKey, unknown> = overrides(checker);
    assembler._typeChecker = new Proxy(checker, {
      get: (target, prop) => (prop in replaced ? replaced[prop] : Reflect.get(target, prop)),
    });
  });
}

function makeGhostSymbol(name: string): ts.Symbol {
  return { name, escapedName: name, flags: ts.SymbolFlags.None, declarations: [] } as unknown as ts.Symbol;
}

function fakeNode(kind: ts.SyntaxKind, props: Record<string, unknown>): ts.Declaration {
  return { kind, ...props } as unknown as ts.Declaration;
}

function findDeclaration(assembler: Assembler, name: string): ts.Declaration {
  for (const file of assembler.program.getSourceFiles()) {
    for (const statement of file.statements) {
      if ((ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name?.text === name) {
        return statement;
      }
    }
  }
  throw new Error(`No declaration named ${name}`);
}

/** The prototype of the TypeScript type objects, so their methods can be spied on. */
function typePrototype(): ts.Type {
  return (ts as any).objectAllocator.getTypeConstructor().prototype;
}

/** The prototype of the TypeScript symbol objects, so their methods can be spied on. */
function symbolPrototype(): ts.Symbol {
  return (ts as any).objectAllocator.getSymbolConstructor().prototype;
}

/**
 * Compiles the given source and returns its diagnostics as "<code>: <message>" strings, leaving out the warnings
 * about missing package metadata (JSII0001 to JSII0003) that every test package gets.
 */
function compileForDiagnostics(source: string): string[] {
  const result = compileJsiiForTest(source, { captureDiagnostics: true });
  return result.diagnostics
    .filter((d) => !JsiiDiagnostic.isJsiiDiagnostic(d) || d.jsiiCode > 3)
    .map((d) => `${JsiiDiagnostic.isJsiiDiagnostic(d) ? `JSII${d.jsiiCode}` : `TS${d.code}`}: ${flatten(d)}`);
}

function flatten(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}
