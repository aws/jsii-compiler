export class Superclass {}
export class Subclass extends Superclass {}

export interface IA {
  foo(): Superclass;
}

export interface IB extends IA {
  // Narrowing the return type is valid TypeScript, but not valid C#.
  foo(): Subclass;
}
