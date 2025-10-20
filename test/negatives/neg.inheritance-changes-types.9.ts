export class Superclass {}
export class Subclass extends Superclass {}

export class SomethingUnspecific {
  public readonly items: Record<string, Superclass> = {};
}

// This should fail - covariant overrides are not allowed with Record mappings
export class SomethingSpecific extends SomethingUnspecific {
  public readonly items: Record<string, Subclass> = {};
}
