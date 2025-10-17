import * as spec from '@jsii/spec';
import { sourceToAssemblyHelper } from '../src';

describe('Covariant overrides in classes are allowed', () => {
  describe('Class properties can be narrowed (covariant)', () => {
    test('direct subclass property override', () => {
      const assembly = sourceToAssemblyHelper(`
        export class Superclass {}
        export class Subclass extends Superclass {}

        export class SomethingUnspecific {
          public readonly something = new Superclass();
        }

        export class SomethingSpecific extends SomethingUnspecific {
          public readonly something: Subclass = new Subclass();
        }
      `);

      expect(assembly.usedFeatures).toContain('class-covariant-overrides');

      expect(assembly.types!['testpkg.SomethingSpecific']).toEqual(
        expect.objectContaining({
          base: 'testpkg.SomethingUnspecific',
          fqn: 'testpkg.SomethingSpecific',
          properties: [
            expect.objectContaining({
              immutable: true,
              name: 'something',
              overrides: 'testpkg.SomethingUnspecific',
              type: {
                fqn: 'testpkg.Subclass',
              },
            }),
          ],
          symbolId: 'index:SomethingSpecific',
        }),
      );
    });

    test('multi-level inheritance property override', () => {
      const assembly = sourceToAssemblyHelper(`
        export class Superclass {}
        export class Subclass extends Superclass {}
        export class SubSubclass extends Subclass {}

        export class Base {
          public readonly something: Superclass = new Superclass();
        }

        export class Middle extends Base {
          public addUnrelatedMember = 3;
        }

        export class Derived extends Middle {
          public readonly something: SubSubclass = new SubSubclass();
        }
      `);

      expect(assembly.usedFeatures).toContain('class-covariant-overrides');

      const derivedType = assembly.types!['testpkg.Derived'] as spec.ClassType;
      expect(derivedType.properties).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            immutable: true,
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

      expect(assembly.usedFeatures).toContain('class-covariant-overrides');

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

  describe('Interface implementation cannot be covariant', () => {
    test('property implementation with narrower type', () => {
      expect(() => {
        sourceToAssemblyHelper(`
        export class Superclass {}
        export class Subclass extends Superclass {}

        export interface ISomething {
          readonly something: Superclass;
        }

        export class SomethingImpl implements ISomething {
          public readonly something: Subclass = new Subclass();
        }
      `);
      }).toThrow('There were compiler errors');
    });

    test('method implementation with narrower return type', () => {
      expect(() => {
        sourceToAssemblyHelper(`
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
      }).toThrow('There were compiler errors');
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
