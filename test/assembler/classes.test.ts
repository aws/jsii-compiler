import * as spec from '@jsii/spec';

import { compileJsiiForTest } from '../../src/helpers';

function classOf(source: string, name = 'Klass'): spec.ClassType {
  const type = compileJsiiForTest(source).assembly.types?.[`testpkg.${name}`];
  expect(type?.kind).toBe(spec.TypeKind.Class);
  return type as spec.ClassType;
}

describe('classes', () => {
  test('a class is registered under the package name, with its source location', () => {
    const klass = classOf('export class Klass {}');

    expect(klass).toMatchObject({
      assembly: 'testpkg',
      fqn: 'testpkg.Klass',
      name: 'Klass',
      locationInModule: { filename: 'index.ts', line: 1 },
    });
  });

  test('a class that is not exported is not part of the assembly', () => {
    const { assembly } = compileJsiiForTest('export class Klass {}\nclass Hidden {}\nvoid Hidden;');

    expect(Object.keys(assembly.types ?? {})).toEqual(['testpkg.Klass']);
  });

  test('the constructor becomes the initializer, with its parameters', () => {
    const klass = classOf(`
      export class Klass {
        public constructor(name: string, count?: number) { void name; void count; }
      }
    `);

    expect(klass.initializer?.parameters).toEqual([
      { name: 'name', type: { primitive: 'string' } },
      { name: 'count', optional: true, type: { primitive: 'number' } },
    ]);
  });

  test('a class without a constructor has no initializer parameters', () => {
    const klass = classOf('export class Klass {}');

    expect(klass.initializer?.parameters).toBeUndefined();
  });

  test('a protected constructor with parameters is a protected initializer', () => {
    const klass = classOf('export class Klass { protected constructor(_name: string) {} }');

    expect(klass.initializer?.protected).toBe(true);
  });

  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/3082
  // The initializer should be protected.
  test('a protected constructor without parameters is not marked as protected', () => {
    const klass = classOf('export class Klass { protected constructor() {} }');

    expect(klass.initializer?.protected).toBeUndefined();
  });

  test('a private constructor leaves the class without an initializer', () => {
    const klass = classOf(
      'export class Klass { private constructor() {} public static create(): Klass { return new Klass(); } }',
    );

    expect(klass.initializer).toBeUndefined();
    expect(klass.methods?.map((m) => m.name)).toEqual(['create']);
  });

  test('an abstract class is marked as abstract, and so are its abstract members', () => {
    const klass = classOf(`
      export abstract class Klass {
        public abstract readonly value: string;
        public abstract compute(): number;
        public concrete(): void {}
      }
    `);

    expect(klass.abstract).toBe(true);
    expect(klass.properties?.find((p) => p.name === 'value')).toMatchObject({ abstract: true, immutable: true });
    expect(klass.methods?.find((m) => m.name === 'compute')).toMatchObject({ abstract: true });
    expect(klass.methods?.find((m) => m.name === 'concrete')?.abstract).toBeUndefined();
  });

  test('a class that is not abstract is not marked as abstract', () => {
    expect(classOf('export class Klass {}').abstract).toBeUndefined();
  });
});

describe('class properties', () => {
  const klass = () =>
    classOf(`
      export class Klass {
        public readonly immutable: string = 'a';
        public mutable: number = 1;
        public optional?: boolean;
        public readonly optionalImmutable?: string;
        protected readonly guarded: string = 'g';
        private readonly hidden: string = 'h';
        public get computed(): string { return 'c'; }
        public get withSetter(): string { return 's'; }
        public set withSetter(_value: string) {}
        public constructor() { void this.hidden; }
      }
    `);
  const property = (name: string) => klass().properties?.find((p) => p.name === name);

  test('readonly properties are immutable', () => {
    expect(property('immutable')).toMatchObject({ immutable: true, type: { primitive: 'string' } });
  });

  test('properties that are not readonly are mutable', () => {
    expect(property('mutable')?.immutable).toBeUndefined();
    expect(property('mutable')?.type).toEqual({ primitive: 'number' });
  });

  test('a question mark makes a property optional', () => {
    expect(property('optional')).toMatchObject({ optional: true, type: { primitive: 'boolean' } });
    expect(property('optionalImmutable')).toMatchObject({ optional: true, immutable: true });
  });

  test('a getter without a setter is immutable', () => {
    expect(property('computed')).toMatchObject({ immutable: true });
  });

  test('a getter with a setter is mutable', () => {
    expect(property('withSetter')?.immutable).toBeUndefined();
  });

  test('protected properties are marked as protected', () => {
    expect(property('guarded')).toMatchObject({ protected: true });
  });

  test('private properties are not part of the assembly', () => {
    expect(property('hidden')).toBeUndefined();
  });
});

describe('class methods', () => {
  test('methods have their parameters and return type', () => {
    const klass = classOf(`
      export class Klass {
        public greet(name: string, times?: number): string { void name; void times; return ''; }
        public nothing(): void {}
      }
    `);

    const [greet, nothing] = klass.methods!;
    expect(greet).toMatchObject({
      name: 'greet',
      parameters: [
        { name: 'name', type: { primitive: 'string' } },
        { name: 'times', optional: true, type: { primitive: 'number' } },
      ],
      returns: { type: { primitive: 'string' } },
    });
    expect(nothing.name).toBe('nothing');
    expect(nothing.returns).toBeUndefined();
  });

  test('a method that may return undefined has an optional return value', () => {
    const klass = classOf('export class Klass { public find(): string | undefined { return undefined; } }');

    expect(klass.methods?.[0].returns).toEqual({ optional: true, type: { primitive: 'string' } });
  });

  test('a rest parameter makes the method variadic', () => {
    const klass = classOf(
      'export class Klass { public join(separator: string, ...parts: string[]): string { void parts; return separator; } }',
    );

    expect(klass.methods?.[0]).toMatchObject({
      variadic: true,
      parameters: [
        { name: 'separator', type: { primitive: 'string' } },
        { name: 'parts', variadic: true, type: { primitive: 'string' } },
      ],
    });
  });

  test('an async method that returns a Promise is marked async, and returns the promised type', () => {
    const klass = classOf('export class Klass { public async fetch(): Promise<number> { return 1; } }');

    expect(klass.methods?.[0]).toMatchObject({ async: true, returns: { type: { primitive: 'number' } } });
  });

  test('protected methods are marked as protected', () => {
    const klass = classOf('export class Klass { protected helper(): void {} }');

    expect(klass.methods?.[0]).toMatchObject({ name: 'helper', protected: true });
  });

  test('private methods are not part of the assembly', () => {
    const klass = classOf('export class Klass { private helper(): void {} public visible(): void { this.helper(); } }');

    expect(klass.methods?.map((m) => m.name)).toEqual(['visible']);
  });
});

describe('static members', () => {
  const klass = () =>
    classOf(`
      export class Klass {
        public static readonly CONSTANT = 42;
        public static readonly INSTANCE: Klass = new Klass();
        public static counter: number = 0;
        public static create(): Klass { return new Klass(); }
      }
    `);

  test('static readonly properties are constants', () => {
    expect(klass().properties?.find((p) => p.name === 'CONSTANT')).toMatchObject({
      static: true,
      const: true,
      immutable: true,
      type: { primitive: 'number' },
    });
  });

  test('static properties can have the type of their own class', () => {
    expect(klass().properties?.find((p) => p.name === 'INSTANCE')).toMatchObject({
      static: true,
      type: { fqn: 'testpkg.Klass' },
    });
  });

  test('static properties that are not readonly are mutable', () => {
    const counter = klass().properties?.find((p) => p.name === 'counter');

    expect(counter?.static).toBe(true);
    expect(counter?.immutable).toBeUndefined();
  });

  test('static methods are marked as static', () => {
    expect(klass().methods?.find((m) => m.name === 'create')).toMatchObject({
      static: true,
      returns: { type: { fqn: 'testpkg.Klass' } },
    });
  });
});

describe('inheritance', () => {
  const source = `
    export interface IFirst { first(): void }
    export interface ISecond { readonly second: string }
    export class Base { public inherited(): void {} public overridden(): string { return 'base'; } }
    export class Derived extends Base implements IFirst, ISecond {
      public readonly second = 's';
      public first(): void {}
      public overridden(): string { return 'derived'; }
    }
  `;
  const derived = () => classOf(source, 'Derived');

  test('the base class is recorded by name', () => {
    expect(derived().base).toBe('testpkg.Base');
  });

  test('the implemented interfaces are recorded, in declaration order', () => {
    expect(derived().interfaces).toEqual(['testpkg.IFirst', 'testpkg.ISecond']);
  });

  test('inherited members are not repeated in the derived class', () => {
    expect(derived().methods?.map((m) => m.name)).not.toContain('inherited');
  });

  test('a member that overrides one of the base class points to it', () => {
    expect(derived().methods?.find((m) => m.name === 'overridden')?.overrides).toBe('testpkg.Base');
  });

  test('a member that implements an interface points to it', () => {
    expect(derived().methods?.find((m) => m.name === 'first')?.overrides).toBe('testpkg.IFirst');
    expect(derived().properties?.find((p) => p.name === 'second')?.overrides).toBe('testpkg.ISecond');
  });

  test('a class without a base class does not have the "base" attribute', () => {
    expect(classOf(source, 'Base').base).toBeUndefined();
  });
});
