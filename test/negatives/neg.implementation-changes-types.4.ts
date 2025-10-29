export class Superclass {}
export class Subclass extends Superclass {}

export interface ISomething {
  takeSomething(_argument: Superclass): void;
}

export interface ISomethingElse extends ISomething {
  addUnrelatedMember: number;
}

// Should still fail even though 2-level inheritance
export class SomethingImpl implements ISomethingElse {
  public addUnrelatedMember: number = 1;
  public takeSomething(_argument: Subclass): void {
    // Nothing
  }
}
