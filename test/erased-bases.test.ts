import * as spec from '@jsii/spec';
import { sourceToAssemblyHelper } from '../src';

// A base type that is not exported from the entry point is erased: its members are copied into its exported subtypes.
// A base declared in another file has to be exported from that file, so whether it is erased must not depend on the
// "export" keyword alone.

test('interface base from a file that is not exported from the entry point is erased', () => {
  const assembly = sourceToAssemblyHelper({
    'index.ts': `
      import { IBase } from './private/base';
      export interface IDerived extends IBase {
        readonly derived: string;
      }
    `,
    'private/base.ts': `
      export interface IBase {
        readonly base: string;
      }
    `,
  });

  expect(Object.keys(assembly.types!)).toEqual(['testpkg.IDerived']);
  const derived = assembly.types!['testpkg.IDerived'] as spec.InterfaceType;
  expect(derived.interfaces).toBeUndefined();
  expect(derived.properties?.map((prop) => prop.name)).toEqual(['base', 'derived']);
});

test('class base from a file that is not exported from the entry point is erased', () => {
  const assembly = sourceToAssemblyHelper({
    'index.ts': `
      import { Base } from './private/base';
      export class Derived extends Base {
        public derived() { return 'derived'; }
      }
    `,
    'private/base.ts': `
      export class Base {
        public base() { return 'base'; }
      }
    `,
  });

  expect(Object.keys(assembly.types!)).toEqual(['testpkg.Derived']);
  const derived = assembly.types!['testpkg.Derived'] as spec.ClassType;
  expect(derived.base).toBeUndefined();
  expect(derived.methods?.map((method) => method.name)).toEqual(['base', 'derived']);
});

test('erasure stops at bases that are exported from the entry point', () => {
  const assembly = sourceToAssemblyHelper({
    'index.ts': `
      import { IMiddle } from './private/middle';
      export * from './root';
      export interface IDerived extends IMiddle {
        readonly derived: string;
      }
    `,
    'private/middle.ts': `
      import { IRoot } from '../root';
      export interface IMiddle extends IRoot {
        readonly middle: string;
      }
    `,
    'root.ts': `
      export interface IRoot {
        readonly root: string;
      }
    `,
  });

  const derived = assembly.types!['testpkg.IDerived'] as spec.InterfaceType;
  expect(derived.interfaces).toEqual(['testpkg.IRoot']);
  expect(derived.properties?.map((prop) => prop.name)).toEqual(['derived', 'middle']);
});

test('bases re-exported from the entry point are not erased', () => {
  const assembly = sourceToAssemblyHelper({
    'index.ts': `
      import { IBase } from './private/base';
      export { IBase } from './private/base';
      export interface IDerived extends IBase {
        readonly derived: string;
      }
    `,
    'private/base.ts': `
      export interface IBase {
        readonly base: string;
      }
    `,
  });

  const derived = assembly.types!['testpkg.IDerived'] as spec.InterfaceType;
  expect(derived.interfaces).toEqual(['testpkg.IBase']);
  expect(derived.properties?.map((prop) => prop.name)).toEqual(['derived']);
});
