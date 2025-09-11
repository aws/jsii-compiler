export class Superclass {}
export class Subclass extends Superclass {}

export interface ISomething {
  something: Superclass;
}

export interface ISomethingElse extends ISomething {
  addUnrelatedMember: number;
}

// Should still fail even though 2-level inheritance
export class SomethingImpl implements ISomethingElse {
  public something: number = 1;
  public addUnrelatedMember = 1;
}
