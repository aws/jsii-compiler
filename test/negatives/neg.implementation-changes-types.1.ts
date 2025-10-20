export class Superclass {}
export class Subclass extends Superclass {}
export class UnrelatedClass {}

export interface ISomething {
  returnSomething(): Superclass;
}

// This should fail - UnrelatedClass is not covariant with Superclass
export class Something implements ISomething {
  public returnSomething(): UnrelatedClass {
    return new UnrelatedClass();
  }
}
