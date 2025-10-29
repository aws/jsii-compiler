import * as spec from '@jsii/spec';
import { compileJsiiForTest } from '../src';
import { compileJsiiForErrors } from './compiler-helpers';

describe('Covariant overrides in classes are allowed', () => {
  describe('Class properties can be narrowed (covariant)', () => {
    test('direct subclass property override', () => {
      const result = compileJsiiForTest(`
        export class Superclass {}
        export class Subclass extends Superclass {}

        export class SomethingUnspecific {
          public readonly something = new Superclass();
        }

        export class SomethingSpecific extends SomethingUnspecific {
          public readonly something: Subclass = new Subclass();
        }
      `);

      expect(result.assembly.usedFeatures).toContain('class-covariant-overrides');

      expect(result.assembly.types!['testpkg.SomethingSpecific']).toEqual(
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
      const result = compileJsiiForTest(`
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

      expect(result.assembly.usedFeatures).toContain('class-covariant-overrides');

      const derivedType = result.assembly.types!['testpkg.Derived'] as spec.ClassType;
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
      const result = compileJsiiForTest(`
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

      expect(result.assembly.usedFeatures).toContain('class-covariant-overrides');

      const derivedType = result.assembly.types!['testpkg.Derived'] as spec.ClassType;
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
      expect(
        compileJsiiForErrors(`
        export class Superclass {}
        export class Subclass extends Superclass {}

        export interface ISomething {
          readonly something: Superclass;
        }

        export class SomethingImpl implements ISomething {
          public readonly something: Subclass = new Subclass();
        }
      `),
      ).toContainEqual(
        expect.stringMatching('changes the property type to "testpkg.Subclass" when implementing testpkg.ISomething'),
      );
    });

    test('method implementation with narrower return type', () => {
      expect(
        compileJsiiForErrors(`
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
      `),
      ).toContainEqual(
        expect.stringMatching('changes the return type to "testpkg.Subclass" when implementing testpkg.ISomething'),
      );
    });
  });

  describe('Static members cannot be covariant', () => {
    test('static properties must have exact same type', () => {
      expect(
        compileJsiiForErrors(`
          export class Superclass {}
          export class Subclass extends Superclass {}

          export class Base {
            public static something: Superclass = new Superclass();
          }

          export class Derived extends Base {
            public static something: Subclass = new Subclass();
          }
        `),
      ).toContainEqual(
        expect.stringMatching('changes the property type to "testpkg.Subclass" when overriding testpkg.Base'),
      );
    });

    test('static methods must have exact same return type', () => {
      expect(
        compileJsiiForErrors(`
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
        `),
      ).toContainEqual(
        expect.stringMatching('changes the return type to "testpkg.Subclass" when overriding testpkg.Base'),
      );
    });
  });

  describe('Parameter types cannot be contravariant', () => {
    test('method parameters cannot widen types in overrides', () => {
      expect(
        compileJsiiForErrors(`
          export class Superclass {}
          export class Subclass extends Superclass {}

          export class Base {
            public takeSomething(param: Subclass): void {}
          }

          export class Derived extends Base {
            public takeSomething(param: Superclass): void {}
          }
        `),
      ).toContainEqual(
        expect.stringMatching(
          'changes the type of parameter "param" to testpkg.Superclass when overriding testpkg.Base',
        ),
      );
    });

    test('method parameters cannot widen types in implementations', () => {
      expect(
        compileJsiiForErrors(`
          export class Superclass {}
          export class Subclass extends Superclass {}

          export interface ISomething {
            takeSomething(param: Subclass): void;
          }

          export class SomethingImpl implements ISomething {
            public takeSomething(param: Superclass): void {}
          }
        `),
      ).toContainEqual(
        expect.stringMatching(
          'changes the type of parameter "param" to testpkg.Superclass when implementing testpkg.ISomething',
        ),
      );
    });
  });

  describe('Covariant overrides in collections', () => {
    describe('Lists support covariant overrides', () => {
      test('property with list type can be narrowed', () => {
        const result = compileJsiiForTest(`
          export class Superclass {}
          export class Subclass extends Superclass {}

          export class Base {
            public readonly items: Superclass[] = [];
          }

          export class Derived extends Base {
            public readonly items: Subclass[] = [];
          }
        `);

        expect(result.assembly.usedFeatures).toContain('class-covariant-overrides');

        const derivedType = result.assembly.types!['testpkg.Derived'] as spec.ClassType;
        expect(derivedType.properties).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'items',
              overrides: 'testpkg.Base',
              type: {
                collection: {
                  elementtype: { fqn: 'testpkg.Subclass' },
                  kind: 'array',
                },
              },
            }),
          ]),
        );
      });

      test('method return with list type can be narrowed', () => {
        const result = compileJsiiForTest(`
          export class Superclass {}
          export class Subclass extends Superclass {}

          export class Base {
            public createItems(): Superclass[] {
              return [];
            }
          }

          export class Derived extends Base {
            public createItems(): Subclass[] {
              return [];
            }
          }
        `);

        expect(result.assembly.usedFeatures).toContain('class-covariant-overrides');

        const derivedType = result.assembly.types!['testpkg.Derived'] as spec.ClassType;
        expect(derivedType.methods).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'createItems',
              overrides: 'testpkg.Base',
              returns: {
                type: {
                  collection: {
                    elementtype: { fqn: 'testpkg.Subclass' },
                    kind: 'array',
                  },
                },
              },
            }),
          ]),
        );
      });
    });

    describe('Record mappings do not support covariant overrides', () => {
      test('property with Record<string, T> type cannot be narrowed', () => {
        expect(
          compileJsiiForErrors(`
            export class Superclass {}
            export class Subclass extends Superclass {}

            export class Base {
              public readonly items: Record<string, Superclass> = {};
            }

            export class Derived extends Base {
              public readonly items: Record<string, Subclass> = {};
            }
          `),
        ).toContainEqual(
          expect.stringMatching('changes the property type to "map<testpkg.Subclass>" when overriding testpkg.Base'),
        );
      });

      test('method return with Record<string, T> type cannot be narrowed', () => {
        expect(
          compileJsiiForErrors(`
            export class Superclass {}
            export class Subclass extends Superclass {}

            export class Base {
              public createItems(): Record<string, Superclass> {
                return {};
              }
            }

            export class Derived extends Base {
              public createItems(): Record<string, Subclass> {
                return {};
              }
            }
          `),
        ).toContainEqual(
          expect.stringMatching('changes the return type to "map<testpkg.Subclass>" when overriding testpkg.Base'),
        );
      });
    });
  });
});
