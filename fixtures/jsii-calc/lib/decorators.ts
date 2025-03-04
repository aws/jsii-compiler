type Constructor = { new (...args: any[]): {} };

export function functionReturnsClasstype<T extends Constructor>(ctr: T) {
  return class extends ctr {
  };
}

/**
 * A class decorator that changes inherited state and adds a readonly field to the class.
 *
 * This wasn't the thing that was exploding, see `function-returning-anonymous-class.ts` for that.
 * Nevertheless, this makes for a good class decorator demo.
 */
export function classDecorator(x: typeof SomeDecoratedClass): typeof SomeDecoratedClass {
  const ret = class extends x {
    constructor() {
      super();
      this.state = this.state + this.state;
    }
  };

  // This adds a field to the class, but we can't reflect that in the type because of the limitations
  // of decorators. That's we advertise it through interface merging below.
  (ret.prototype as any)['field'] = 'some_added_field';

  return ret;
}

@classDecorator
export class SomeDecoratedClass {
  protected state = 'state';

  public accessState() {
    return this.state;
  }
}

export interface SomeDecoratedClass {
  readonly field: string;
}

/**
 * Exercise the above code
 */
function tryDecoratedClass() {
  const instance = new SomeDecoratedClass();
  return instance.field;
}
// Suppress unused locals warnings
void tryDecoratedClass;