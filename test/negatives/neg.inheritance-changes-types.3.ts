export class Superclass {}
export class Subclass extends Superclass {}

export class Something {
  public takeSomething(_argument: Superclass): void {
    // Nothing
  }
}

// This should fail - covariant parameter types are not allowed in C#
// see https://github.com/dotnet/csharplang/discussions/3562 for details
// "Symmetry is not a goal of the language. If the proposal can't provide enough benefit to stand on its own it wouldn't be considered.
// Contravariant parameters would be a lot more effort for a lot less reward."
export class SomethingSpecific extends Something {
  public takeSomething(_argument: Subclass): void {
    // Nothing
  }
}
