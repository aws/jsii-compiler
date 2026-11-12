export interface A {
  readonly foo?: string;
}

export interface B extends A {
  // Making an optional member required changes its shape.
  readonly foo: string;
}
