export interface IWithIndex {
  readonly bamboodle: number;
  // This is not supported on the jsii type system!
  readonly [key: string]: number;
}

export class WithStaticIndex {
  // This is not supported on the jsii type system!
  static readonly [key: string]: string;

  private constructor() { }
}
