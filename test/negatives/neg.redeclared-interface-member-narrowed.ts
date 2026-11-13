export class Superclass {}
export class Subclass extends Superclass {}

export interface IA {
  readonly foo: Superclass;
}

export interface IB extends IA {
  // Narrowing is valid TypeScript, but C# interfaces have no covariance.
  readonly foo: Subclass;
}
