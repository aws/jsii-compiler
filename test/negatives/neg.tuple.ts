export interface TupleProp {
  readonly stringNumber: [string, number];
  readonly stringString: [string, string];
  readonly stringNumbers: [string, ...number[]];
  readonly namedTuple: [first: string, second: number, ...rest: boolean[]];
}
