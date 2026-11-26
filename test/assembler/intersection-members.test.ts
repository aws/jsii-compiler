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

  test('is not reported for members declared identically', () => {
    expect(compileIntersection('method(x?: string): number', 'method(x?: string): number')).toEqual([]);
  });

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
    export interface IA { ${membersOfA} }
    export interface IB { ${membersOfB} }
    export class Consumer {
      public consume(_value: IA & IB): void {}
    }
  `);
}
