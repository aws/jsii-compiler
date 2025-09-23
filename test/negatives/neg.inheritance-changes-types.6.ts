export class Superclass {}
export class Subclass extends Superclass {}

export class SomethingUnspecific {
  public readonly something = new Subclass();
}

// This should fail - contravariant property changes are not allowed
export class SomethingSpecific extends SomethingUnspecific {
  public readonly something: Superclass = new Superclass();
}
