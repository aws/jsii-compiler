export class Superclass {}
export class Subclass extends Superclass {}

export class SomethingUnspecific {
  public getItems(): Record<string, Superclass> {
    return {};
  }
}

// This should fail - covariant overrides are not allowed with Record mappings in method return types
export class SomethingSpecific extends SomethingUnspecific {
  public getItems(): Record<string, Subclass> {
    return {};
  }
}
