type Constructor = { new (...args: any[]): {} };

/**
 * Just the mere presence of this function is enough to break jsii, even if it's not exported
 *
 * The reason is that when we add deprecation warnings we visit all functions in all files.
 */
export function propertyInjectionDecorator<T extends Constructor>(ctr: T) {
  // Important for the bug: the anonymous class extends something, *and*
  // declares a method.
  return class extends ctr {
    public someMethod(): string {
      return 'abc';
    }
  };
}