import { compileJsiiForErrors } from './compiler-helpers';
import { compileJsiiForTest, TestWorkspace } from '../src';

/**
 * Which types an overriding member may use in place of the type of the member it overrides (JSII5003 for the return
 * type of methods, JSII5004 for properties). The rules are driven by what C# can express.
 */

const TYPES = `
  export interface IBase {}
  export interface IDerived extends IBase {}
  export class Sup {}
  export class Sub extends Sup implements IDerived {}
  export class Other {}
`;

function overrideReturning(superType: string, subType: string) {
  return compileJsiiForErrors(`
    ${TYPES}
    export class A { public m(): ${superType} { return undefined as any; } }
    export class B extends A { public m(): ${subType} { return undefined as any; } }
  `);
}

function overrideProperty(superType: string, subType: string) {
  return compileJsiiForErrors(`
    ${TYPES}
    export class A { public readonly p: ${superType} = undefined as any; }
    export class B extends A { public readonly p: ${subType} = undefined as any; }
  `);
}

describe('allowed', () => {
  test.each([
    ['the same type', 'Sup', 'Sup'],
    ['a subclass', 'Sup', 'Sub'],
    ['an array of a subclass', 'Sup[]', 'Sub[]'],
    ['an interface that extends it', 'IBase', 'IDerived'],
    ['a class that implements the interface', 'IBase', 'Sub'],
  ])('overriding with %s', (_, superType, subType) => {
    expect(overrideReturning(superType, subType)).toEqual([]);
    expect(overrideProperty(superType, subType)).toEqual([]);
  });

  test('overriding with a class that implements the interface through its base class', () => {
    expect(
      compileJsiiForErrors(`
        export interface IBase {}
        export class Mid implements IBase {}
        export class Leaf extends Mid {}
        export class A { public m(): IBase { return new Mid(); } }
        export class B extends A { public m(): Leaf { return new Leaf(); } }
      `),
    ).toEqual([]);
  });

  test('overriding with a class that implements an interface that extends the interface', () => {
    expect(
      compileJsiiForErrors(`
        export interface IA {}
        export interface IB extends IA {}
        export interface IC extends IB {}
        export class Impl implements IC {}
        export class A { public m(): IA { return new Impl(); } }
        export class B extends A { public m(): Impl { return new Impl(); } }
      `),
    ).toEqual([]);
  });
});

describe('allowed, with other differences', () => {
  test('overriding an optional return value with a required one of the same type', () => {
    expect(
      compileJsiiForErrors(`
        export class Sup {}
        export class A { public m(): Sup | undefined { return undefined; } }
        export class B extends A { public m(): Sup { return new Sup(); } }
      `),
    ).toEqual([]);
  });

  test('overriding an interface with a class that implements it directly', () => {
    expect(
      compileJsiiForErrors(`
        export interface IBase {}
        export class Impl implements IBase {}
        export class A { public m(): IBase { return new Impl(); } }
        export class B extends A { public m(): Impl { return new Impl(); } }
      `),
    ).toEqual([]);
  });

  test('overriding an interface with an interface that extends it through another interface', () => {
    expect(
      compileJsiiForErrors(`
        export interface IA {}
        export interface IB extends IA {}
        export interface IC extends IB {}
        export class Impl implements IC {}
        export class A { public m(): IA { return new Impl(); } }
        export class B extends A { public m(): IC { return new Impl(); } }
      `),
    ).toEqual([]);
  });
});

describe('not allowed, although TypeScript allows it (it compares the shape of types)', () => {
  test('a required property in place of an optional one', () => {
    expect(
      compileJsiiForErrors(`
        export class Sup {}
        export class A { public readonly p?: Sup; }
        export class B extends A { public readonly p: Sup = new Sup(); }
      `),
    ).toEqual(['"testpkg.B#p" turns required when overriding testpkg.A. Make it optional']);
  });

  test('an interface that does not extend the interface it is compared to', () => {
    expect(
      compileJsiiForErrors(`
        export interface IA {}
        export interface IB {}
        export class A { public m(): IA { return undefined as any; } }
        export class B extends A { public m(): IB { return undefined as any; } }
      `),
    ).toEqual([
      '"testpkg.B#m" changes the return type to "testpkg.IB" when overriding testpkg.A. Change it to "testpkg.IA"',
    ]);
  });

  test('an interface instead of a class', () => {
    expect(
      compileJsiiForErrors(`
        export class Klass {}
        export interface IKlass {}
        export class A { public m(): Klass { return undefined as any; } }
        export class B extends A { public m(): IKlass { return undefined as any; } }
      `),
    ).toEqual([
      '"testpkg.B#m" changes the return type to "testpkg.IKlass" when overriding testpkg.A. Change it to "testpkg.Klass"',
    ]);
  });

  test('a class that implements an interface that does not extend the interface it is compared to', () => {
    expect(
      compileJsiiForErrors(`
        export interface IA {}
        export interface IB {}
        export class Impl implements IB {}
        export class A { public m(): IA { return undefined as any; } }
        export class B extends A { public m(): Impl { return undefined as any; } }
      `),
    ).toEqual([
      '"testpkg.B#m" changes the return type to "testpkg.Impl" when overriding testpkg.A. Change it to "testpkg.IA"',
    ]);
  });
});

describe('types from a dependency', () => {
  function overrideWithForeignTypes(subType: string) {
    return TestWorkspace.withWorkspace((ws) => {
      ws.addDependency(
        compileJsiiForTest('export class ForeignBase {} export class ForeignDerived extends ForeignBase {}', {
          packageJson: { name: 'dependency' },
        }),
      );
      return compileJsiiForErrors(
        `
          import { ForeignBase, ForeignDerived } from 'dependency';
          export class Other {}
          export class Uses { public readonly derived = new ForeignDerived(); }
          export class A { public m(): ForeignBase { return new ForeignBase(); } }
          export class B extends A { public m(): ${subType} { return undefined as any; } }
        `,
        {
          compilationDirectory: ws.rootDirectory,
          packageJson: { dependencies: { dependency: '*' }, peerDependencies: { dependency: '*' } },
        },
      );
    });
  }

  test('can be narrowed to a subclass', () => {
    expect(overrideWithForeignTypes('ForeignDerived')).toEqual([]);
  });

  test('cannot be changed to an unrelated class', () => {
    expect(overrideWithForeignTypes('Other')).toEqual([
      '"testpkg.B#m" changes the return type to "testpkg.Other" when overriding testpkg.A. Change it to "dependency.ForeignBase"',
    ]);
  });
});

describe('not allowed', () => {
  test('returning a value where the overridden method returns nothing', () => {
    expect(overrideReturning('void', 'string')).toEqual([
      '"testpkg.B#m" changes the return type to "string" when overriding testpkg.A. Change it to "void"',
    ]);
  });

  test('an array of an unrelated class', () => {
    expect(overrideReturning('Sup[]', 'Other[]')).toEqual([
      '"testpkg.B#m" changes the return type to "array<testpkg.Other>" when overriding testpkg.A. Change it to "array<testpkg.Sup>"',
    ]);
  });

  test('a map of a subclass', () => {
    expect(overrideReturning('Record<string, Sup>', 'Record<string, Sub>')).toEqual([
      '"testpkg.B#m" changes the return type to "map<testpkg.Sub>" when overriding testpkg.A. Change it to "map<testpkg.Sup>"',
    ]);
  });

  test('a narrower union', () => {
    expect(overrideReturning('Sup | string', 'Sup')).toEqual([
      '"testpkg.B#m" changes the return type to "testpkg.Sup" when overriding testpkg.A. Change it to "string | testpkg.Sup"',
    ]);
    expect(overrideProperty('Sup | string', 'Sup')).toEqual([
      '"testpkg.B#p" changes the property type to "testpkg.Sup" when overriding testpkg.A. Change it to "string | testpkg.Sup"',
    ]);
  });

  test('a different primitive', () => {
    expect(overrideReturning('string | number', 'string')).toEqual([
      '"testpkg.B#m" changes the return type to "string" when overriding testpkg.A. Change it to "number | string"',
    ]);
  });

  test('an unrelated class instead of an interface', () => {
    expect(overrideReturning('IBase', 'Other')).toEqual([
      '"testpkg.B#m" changes the return type to "testpkg.Other" when overriding testpkg.A. Change it to "testpkg.IBase"',
    ]);
  });

  test('a class that does not extend the overridden class, even when it has the same shape', () => {
    expect(
      compileJsiiForErrors(`
        export class X {}
        export class Y {}
        export class A { public m(): X { return new X(); } }
        export class B extends A { public m(): Y { return new Y(); } }
      `),
    ).toEqual([
      '"testpkg.B#m" changes the return type to "testpkg.Y" when overriding testpkg.A. Change it to "testpkg.X"',
    ]);
  });
});

describe('re-declaring an interface member (JSII5015)', () => {
  const JSII5015 =
    'Interface "testpkg.IB" re-declares member "m" with a different type or signature. Re-declared members must match the inherited declaration exactly, as C# interfaces cannot narrow inherited members.';

  test.each([
    ['a narrower union', 'm(): string | number', 'm(): string'],
    ['a different return type', 'm(): string[]', 'm(): number[]'],
    ['a different parameter type', 'm(x: string): void', 'm(x: number): void'],
    ['a different map type', 'm(): Record<string, string>', 'm(): Record<string, number>'],
  ])('is reported for %s', (_, inherited, redeclared) => {
    const errors = compileJsiiForErrors(`
      export interface IA { ${inherited}; }
      export interface IB extends IA { ${redeclared}; }
    `);

    expect(errors).toContain(JSII5015);
  });
});

describe('static members and nested types', () => {
  test('an enum can share its name with a namespace of nested types', () => {
    expect(
      compileJsiiForErrors(`
        export enum Color { RED, GREEN }
        export namespace Color { export class Red {} }
      `),
    ).toEqual([]);
  });
});
