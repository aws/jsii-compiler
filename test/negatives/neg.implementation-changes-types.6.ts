export class Superclass {}
export class Subclass extends Superclass {}

export interface ISomething {
  something: Superclass;
}

// This should fail - covariant changes are not allowed on implementations
export class SomethingImpl implements ISomething {
  public something: Subclass = new Subclass();
}
