export class Superclass {}
export class Subclass extends Superclass {}

export class Something {
  public takeSomething(_argument: Superclass): void {
    // Nothing
  }
}

export class SomethingElse extends Something {
  public addUnrelatedMember: number = 1;
}

// Should still fail even though 2-level inheritance
export class SomethingSpecific extends SomethingElse {
  public takeSomething(_argument: Subclass): void {
    // Nothing
  }
}
