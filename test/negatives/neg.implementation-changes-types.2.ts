export class Superclass {}
export class Subclass extends Superclass {}

export interface ISomething {
  takeSomething(_argument: Subclass): void;
}

// This should fail - contravariant parameter types are not allowed
export class ISomethingElse implements ISomething {
  public takeSomething(_argument: Superclass): void {
    // Nothing
  }
}
