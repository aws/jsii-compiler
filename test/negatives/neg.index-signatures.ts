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

export interface InternalIsIgnoredOnInterface {
  readonly hello: number;

  /**
   * There should NOT be an error marker on this index signature, as it's marked
   * jsii-ignore.
   *
   * @jsii ignore
   */
  readonly [key: string]: number;
}

export class InternalIsIgnoredOnClass {
  readonly hello: number;

  /**
   * There should NOT be an error marker on this index signature, as it's marked
   * jsii-ignore.
   *
   *  @jsii ignore
   */
  readonly [key: string]: number;

  private constructor() {
    this.hello = 1337;
  }
}
