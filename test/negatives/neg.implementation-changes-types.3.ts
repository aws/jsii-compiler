export class Superclass {}
export class Subclass extends Superclass {}

export interface ISomething {
  takeSomething(_argument: Superclass): void;
}

// This should fail - covariant parameter types are not allowed
export class Something implements ISomething {
  public takeSomething(_argument: Subclass): void {
    // Nothing
  }
}
