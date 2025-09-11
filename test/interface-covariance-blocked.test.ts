import { sourceToAssemblyHelper } from '../src';

/**
 * These test cases exists to demonstrate interface-to-interface
 * covariance that should technically work.
 *
 * However JSII5015 is currently blocking interfaces from re-declaring
 * members. This used to be a C# limitation, but is likely outdated.
 */

describe('Interface covariance is currently blocked by JSII5015', () => {
  test('interface extending interface with covariant property fails', () => {
    expect(() => {
      sourceToAssemblyHelper(`
        export class Superclass {}
        export class Subclass extends Superclass {}

        export interface IBase {
          readonly something: Superclass;
        }

        export interface IDerived extends IBase {
          readonly something: Subclass;  // This is covariant and should be allowed
        }
      `);
    }).toThrow('There were compiler errors');
  });

  test('interface extending interface with covariant method fails', () => {
    expect(() => {
      sourceToAssemblyHelper(`
        export class Superclass {}
        export class Subclass extends Superclass {}

        export interface IBase {
          createSomething(): Superclass;
        }

        export interface IDerived extends IBase {
          createSomething(): Subclass;  // This is covariant and should be allowed
        }
      `);
    }).toThrow('There were compiler errors');
  });
});
