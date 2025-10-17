export class Superclass {}

export class SomethingUnspecific {
  public readonly something = new Superclass();
}

// This should fail - cannot change to mutability
export class SomethingSpecific extends SomethingUnspecific {
  public something: Superclass = new Superclass();
}
