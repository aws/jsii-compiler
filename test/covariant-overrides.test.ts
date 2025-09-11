import * as spec from '@jsii/spec';
import { sourceToAssemblyHelper } from '../src';

describe('Covariant overrides are now allowed', () => {
  describe('Class properties can be narrowed (covariant)', () => {
    test('direct subclass property override', () => {
      const assembly = sourceToAssemblyHelper(`
        export class Superclass {}
        export class Subclass extends Superclass {}

        export class SomethingUnspecific {
          public something = new Superclass();
        }

        export class SomethingSpecific extends SomethingUnspecific {
          public something: Subclass = new Subclass();
        }
      `);

      expect(assembly.types!['testpkg.SomethingSpecific']).toEqual({
        assembly: 'testpkg',
        base: 'testpkg.SomethingUnspecific',
        fqn: 'testpkg.SomethingSpecific',
        initializer: {},
        kind: 'class',
        locationInModule: {
          filename: 'index.ts',
          line: 9,
        },
        name: 'SomethingSpecific',
        properties: [
          {
            locationInModule: {
              filename: 'index.ts',
              line: 10,
            },
            name: 'something',
            overrides: 'testpkg.SomethingUnspecific',
            type: {
              fqn: 'testpkg.Subclass',
            },
          },
        ],
        symbolId: 'index:SomethingSpecific',
      });
    });

    test('multi-level inheritance property override', () => {
      const assembly = sourceToAssemblyHelper(`
        export class Superclass {}
        export class Subclass extends Superclass {}
        export class SubSubclass extends Subclass {}

        export class Base {
          public something: Superclass = new Superclass();
        }

        export class Middle extends Base {
          public addUnrelatedMember = 3;
        }

        export class Derived extends Middle {
          public something: SubSubclass = new SubSubclass();
        }
      `);

      const derivedType = assembly.types!['testpkg.Derived'] as spec.ClassType;
      expect(derivedType.properties).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'something',
            overrides: 'testpkg.Base',
            type: { fqn: 'testpkg.SubSubclass' },
          }),
        ]),
      );
    });
  });

  describe('Method return types can be narrowed (covariant)', () => {
    test('method return type override', () => {
      const assembly = sourceToAssemblyHelper(`
        export class Superclass {}
        export class Subclass extends Superclass {}

        export class Base {
          public createSomething(): Superclass {
            return new Superclass();
          }
        }

        export class Derived extends Base {
          public createSomething(): Subclass {
            return new Subclass();
          }
        }
      `);

      const derivedType = assembly.types!['testpkg.Derived'] as spec.ClassType;
      expect(derivedType.methods).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'createSomething',
            overrides: 'testpkg.Base',
            returns: { type: { fqn: 'testpkg.Subclass' } },
          }),
        ]),
      );
    });
  });

  describe('Interface implementation can be covariant', () => {
    test('property implementation with narrower type', () => {
      const assembly = sourceToAssemblyHelper(`
        export class Superclass {}
        export class Subclass extends Superclass {}

        export interface ISomething {
          readonly something: Superclass;
        }

        export class SomethingImpl implements ISomething {
          public readonly something: Subclass = new Subclass();
        }
      `);

      const implType = assembly.types!['testpkg.SomethingImpl'] as spec.ClassType;
      expect(implType.properties).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'something',
            overrides: 'testpkg.ISomething',
            type: { fqn: 'testpkg.Subclass' },
          }),
        ]),
      );
    });

    test('method implementation with narrower return type', () => {
      const assembly = sourceToAssemblyHelper(`
        export class Superclass {}
        export class Subclass extends Superclass {}

        export interface ISomething {
          createSomething(): Superclass;
        }

        export class SomethingImpl implements ISomething {
          public createSomething(): Subclass {
            return new Subclass();
          }
        }
      `);

      const implType = assembly.types!['testpkg.SomethingImpl'] as spec.ClassType;
      expect(implType.methods).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'createSomething',
            overrides: 'testpkg.ISomething',
            returns: { type: { fqn: 'testpkg.Subclass' } },
          }),
        ]),
      );
    });
  });

  describe('Static members cannot be covariant', () => {
    test('static properties must have exact same type', () => {
      expect(() => {
        sourceToAssemblyHelper(`
          export class Superclass {}
          export class Subclass extends Superclass {}

          export class Base {
            public static something: Superclass = new Superclass();
          }

          export class Derived extends Base {
            public static something: Subclass = new Subclass();
          }
        `);
      }).toThrow('There were compiler errors');
    });

    test('static methods must have exact same return type', () => {
      expect(() => {
        sourceToAssemblyHelper(`
          export class Superclass {}
          export class Subclass extends Superclass {}

          export class Base {
            public static createSomething(): Superclass {
              return new Superclass();
            }
          }

          export class Derived extends Base {
            public static createSomething(): Subclass {
              return new Subclass();
            }
          }
        `);
      }).toThrow('There were compiler errors');
    });
  });

  describe('Parameter types cannot be contravariant', () => {
    test('method parameters cannot widen types in overrides', () => {
      expect(() => {
        sourceToAssemblyHelper(`
          export class Superclass {}
          export class Subclass extends Superclass {}

          export class Base {
            public takeSomething(param: Subclass): void {}
          }

          export class Derived extends Base {
            public takeSomething(param: Superclass): void {}
          }
        `);
      }).toThrow('There were compiler errors');
    });

    test('method parameters cannot widen types in implementations', () => {
      expect(() => {
        sourceToAssemblyHelper(`
          export class Superclass {}
          export class Subclass extends Superclass {}

          export interface ISomething {
            takeSomething(param: Subclass): void;
          }

          export class SomethingImpl implements ISomething {
            public takeSomething(param: Superclass): void {}
          }
        `);
      }).toThrow('There were compiler errors');
    });
  });
});
