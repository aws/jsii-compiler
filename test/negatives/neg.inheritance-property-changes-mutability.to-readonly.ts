export class Superclass {}

export class SomethingUnspecific {
  public something = new Superclass();
}

// This should fail - cannot change mutability
export class SomethingSpecific extends SomethingUnspecific {
  public readonly something: Superclass = new Superclass();
}
