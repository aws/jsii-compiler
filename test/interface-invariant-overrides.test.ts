import * as spec from '@jsii/spec';
import { compileJsiiForTest } from '../src';

// See: https://github.com/projen/projen/issues/1172
describe('Interfaces may re-declare inherited members with an identical shape', () => {
  test('struct property, to change its documented default', () => {
    const result = compileJsiiForTest(`
      export interface BaseOptions {
        /** @default "base" */
        readonly name?: string;
      }
      export interface ChildOptions extends BaseOptions {
        /** @default "child" */
        readonly name?: string;
      }
    `);

    expect(result.assembly.usedFeatures).toContain('interface-invariant-overrides');

    const child = result.assembly.types!['testpkg.ChildOptions'] as spec.InterfaceType;
    expect(child.properties).toEqual([
      expect.objectContaining({
        name: 'name',
        optional: true,
        overrides: 'testpkg.BaseOptions',
        docs: { default: '"child"' },
      }),
    ]);
  });

  test('behavioral interface property', () => {
    const result = compileJsiiForTest(`
      export interface IA {
        readonly foo: number;
      }
      export interface IB extends IA {
        /** Better docs. */
        readonly foo: number;
      }
    `);

    const ib = result.assembly.types!['testpkg.IB'] as spec.InterfaceType;
    expect(ib.properties).toEqual([expect.objectContaining({ name: 'foo', overrides: 'testpkg.IA' })]);
  });

  test('method', () => {
    const result = compileJsiiForTest(`
      export interface IA {
        foo(x: string): void;
      }
      export interface IB extends IA {
        /** Better docs. */
        foo(x: string): void;
      }
    `);

    const ib = result.assembly.types!['testpkg.IB'] as spec.InterfaceType;
    expect(ib.methods).toEqual([expect.objectContaining({ name: 'foo', overrides: 'testpkg.IA' })]);
  });

  test('deeper in the hierarchy, overrides points at the nearest declaration', () => {
    const result = compileJsiiForTest(`
      export interface IA {
        foo(): void;
      }
      export interface IB extends IA {
        bar(): void;
      }
      export interface IC extends IB {
        foo(): void;
      }
      export interface ID extends IC {
        foo(): void;
      }
    `);

    const ic = result.assembly.types!['testpkg.IC'] as spec.InterfaceType;
    expect(ic.methods).toEqual([expect.objectContaining({ name: 'foo', overrides: 'testpkg.IA' })]);
    const id = result.assembly.types!['testpkg.ID'] as spec.InterfaceType;
    expect(id.methods).toEqual([expect.objectContaining({ name: 'foo', overrides: 'testpkg.IC' })]);
  });

  test('assemblies without re-declarations do not use the feature', () => {
    const result = compileJsiiForTest(`
      export interface IA {
        readonly foo: number;
      }
      export interface IB extends IA {
        readonly bar: number;
      }
    `);

    expect(result.assembly.usedFeatures ?? []).not.toContain('interface-invariant-overrides');
  });
});
