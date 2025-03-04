function classDecorator(x: typeof SomeDecoratedClass, _context: ClassDecoratorContext): typeof SomeDecoratedClass {
  const ret = class extends x {
    constructor() {
      super();
      this.state = this.state + this.state;
    }
  };

  // This adds a field to the class, but we can't reflect that in the type because of the limitations
  // of decorators. That's we advertise it through interface merging below.
  ret.prototype['field'] = 'some_added_field';

  return ret;
}

function methodDecorator<A extends Function>(x: A, _context: ClassMethodDecoratorContext): A {
  return x;
}

@classDecorator
export class SomeDecoratedClass {
  protected state = 'state';

  @methodDecorator
  public accessState() {
    return this.state;
  }
}

export interface SomeDecoratedClass {
  field: string;
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