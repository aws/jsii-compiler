export class Superclass {}
export class Subclass extends Superclass {}
export class UnrelatedClass {}

export class Something {
  public returnSomething(): Superclass {
    return new Superclass();
  }
}

// This should fail - UnrelatedClass is not covariant with Superclass
export class SomethingSpecific extends Something {
  public returnSomething(): UnrelatedClass {
    return new UnrelatedClass();
  }
}
