export class Superclass {}
export class Subclass extends Superclass {}

export class SomethingUnspecific {
  public something = new Superclass();
}

// This should fail - covariant property changes are only allowed on readonly properties
export class SomethingSpecific extends SomethingUnspecific {
  public something: Subclass = new Subclass();
}
