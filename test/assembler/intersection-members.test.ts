import { compileForDiagnostics } from './helpers';

// Members that appear in more than one type of an intersection must be declared identically.
describe('JSII1011 typescript-restriction/intersection-member-different', () => {
  test.each([
    {
      what: 'a property type',
      a: 'readonly member: string',
      b: 'readonly member: number',
      reasons: ['string', 'number'],
    },
    {
      what: 'the element type of an array',
      a: 'readonly member: string[]',
      b: 'readonly member: number[]',
      reasons: ['array<string>', 'array<number>'],
    },
    {
      what: 'an array against a map',
      a: 'readonly member: string[]',
      b: 'readonly member: Record<string, string>',
      reasons: ['array<string>', 'map<string>'],
    },
    {
      what: 'a union of types',
      a: 'readonly member: string | number',
      b: 'readonly member: string | boolean',
      reasons: ['string | number', 'string | boolean'],
    },
    {
      what: 'the number of types in a union',
      a: 'readonly member: string | number',
      b: 'readonly member: string | number | boolean',
      reasons: ['string | number', 'string | number | boolean'],
    },
    {
      what: 'an intersection of types',
      a: 'member(x: IX & IY): void',
      b: 'member(x: IX & IZ): void',
      reasons: ['testpkg.IX & testpkg.IY', 'testpkg.IX & testpkg.IZ'],
    },
    {
      what: 'the number of types in an intersection',
      a: 'member(x: IX & IY): void',
      b: 'member(x: IX & IY & IZ): void',
      reasons: ['testpkg.IX & testpkg.IY', 'testpkg.IX & testpkg.IY & testpkg.IZ'],
    },
    {
      what: 'a class against a primitive',
      a: 'readonly member: Other',
      b: 'readonly member: string',
      reasons: ['testpkg.Other', 'string'],
    },
    {
      what: 'a property being optional',
      a: 'readonly member?: string',
      b: 'readonly member: string',
      reasons: ['optional', 'required'],
    },
    {
      what: 'a method return type',
      a: 'member(): string',
      b: 'member(): number',
      reasons: ['string', 'number'],
    },
    {
      what: 'a method return type being optional',
      a: 'member(): string | undefined',
      b: 'member(): string',
      reasons: ['return type optional', 'return type required'],
    },
    {
      what: 'the number of method parameters',
      a: 'member(): void',
      b: 'member(x: string): void',
      reasons: ['0 parameters', '1 parameters'],
    },
    {
      what: 'a method parameter type',
      a: 'member(x: string): void',
      b: 'member(x: number): void',
      reasons: ['string', 'number'],
    },
    {
      what: 'a method parameter being optional',
      a: 'member(x?: string): void',
      b: 'member(x: string): void',
      reasons: ['parameter 1 optional', 'parameter 1 required'],
    },
    {
      what: 'a method parameter being variadic',
      a: 'member(...x: string[]): void',
      b: 'member(x: string): void',
      reasons: ['parameter 1 variadic', 'parameter 1 not variadic'],
    },
  ])('is reported when the types disagree on $what', ({ a, b, reasons: [reasonA, reasonB] }) => {
    expect(compileIntersection(a, b)).toEqual([
      `JSII1011: Member member is different between types in a type intersection: IA (${reasonA}) and IB (${reasonB})`,
    ]);
  });

  test('is not reported for members that only one of the types declares', () => {
    expect(
      compileIntersection('readonly prop: string; method(): void', 'readonly other: string; other2(): void'),
    ).toEqual([]);
  });

  test('is not reported for a parameter that is an intersection, declared identically', () => {
    expect(compileIntersection('member(x: IX & IY): void', 'member(x: IX & IY): void')).toEqual([]);
  });

  test('is not reported for members declared identically', () => {
    expect(compileIntersection('method(x?: string): number', 'method(x?: string): number')).toEqual([]);
  });

  test.each(['string[]', 'Record<string, string>', 'string | number', 'Other', 'Other[]', 'Array<string | Other>'])(
    'is not reported for a property of type %s declared identically',
    (type) => {
      expect(compileIntersection(`readonly member: ${type}`, `readonly member: ${type}`)).toEqual([]);
    },
  );

  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2955
  test('is not reported when the types disagree on a method being async', () => {
    expect(compileIntersection('member(): Promise<string>', 'member(): string')).toEqual([]);
  });
});

/**
 * Compiles two behavioral interfaces with the given members and a method that accepts their intersection.
 */
function compileIntersection(membersOfA: string, membersOfB: string): string[] {
  return compileForDiagnostics(`
    export class Other {}
    export interface IX { readonly x: string }
    export interface IY { readonly y: string }
    export interface IZ { readonly z: string }
    export interface IA { ${membersOfA} }
    export interface IB { ${membersOfB} }
    export class Consumer {
      public consume(_value: IA & IB): void {}
    }
  `);
}
