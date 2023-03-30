export class GenericClass<T extends object> {
  private constructor() { }

  public retrieveGeneric(): T {
    return {} as any;
  }
}

export interface GenericStruct<T> {
  readonly generic: T;
}

export interface IGenericBehavior<T extends object | string> {
  genericMethod(param: T): void;
}
