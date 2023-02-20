export interface IWithIndex {
  readonly bamboodle: number;
  // This is not supported on the jsii type system!
  readonly [key: symbol]: number;
}

export class WithStaticIndex {
  // This is not supported on the jsii type system!
  static readonly [key: symbol]: string;

  private constructor() { }
}
