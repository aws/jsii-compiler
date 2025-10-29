export class Superclass {}
export class Subclass extends Superclass {}

export class Something {
  public takeSomething(_argument: Subclass): void {
    // Nothing
  }
}

// This should fail - contravariant parameter types are not allowed
export class SomethingSpecific extends Something {
  public takeSomething(_argument: Superclass): void {
    // Nothing
  }
}
