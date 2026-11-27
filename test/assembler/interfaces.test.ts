import * as spec from '@jsii/spec';

import { compileForDiagnostics } from './helpers';
import { compileJsiiForTest } from '../../src/helpers';

function typeOf<T extends spec.Type>(source: string, name: string, kind: spec.TypeKind): T {
  const type = compileJsiiForTest(source).assembly.types?.[`testpkg.${name}`];
  expect(type?.kind).toBe(kind);
  return type as T;
}
const interfaceOf = (source: string, name: string) => typeOf<spec.InterfaceType>(source, name, spec.TypeKind.Interface);
const enumOf = (source: string, name: string) => typeOf<spec.EnumType>(source, name, spec.TypeKind.Enum);

describe('behavioral interfaces', () => {
  const source = `
    export interface IGreeter {
      readonly language: string;
      greet(name: string): string;
    }
    export interface IFormalGreeter extends IGreeter {
      title?: string;
    }
  `;

  test('an interface named with the "I" prefix is a behavioral interface, not a struct', () => {
    const greeter = interfaceOf(source, 'IGreeter');

    expect(greeter.datatype).toBeUndefined();
    expect(greeter.fqn).toBe('testpkg.IGreeter');
  });

  test('its members are abstract', () => {
    const greeter = interfaceOf(source, 'IGreeter');

    expect(greeter.properties).toMatchObject([
      { name: 'language', abstract: true, immutable: true, type: { primitive: 'string' } },
    ]);
    expect(greeter.methods).toMatchObject([
      {
        name: 'greet',
        abstract: true,
        parameters: [{ name: 'name', type: { primitive: 'string' } }],
        returns: { type: { primitive: 'string' } },
      },
    ]);
  });

  test('an interface can extend another interface, and only declares its own members', () => {
    const formal = interfaceOf(source, 'IFormalGreeter');

    expect(formal.interfaces).toEqual(['testpkg.IGreeter']);
    expect(formal.properties).toMatchObject([{ name: 'title', optional: true, abstract: true }]);
    expect(formal.methods).toBeUndefined();
  });

  test('a property that is not readonly is mutable', () => {
    const formal = interfaceOf(source, 'IFormalGreeter');

    expect(formal.properties?.[0].immutable).toBeUndefined();
  });

  test('an interface without the "I" prefix that has methods is not allowed', () => {
    expect(compileForDiagnostics('export interface Greeter { greet(): void }')).toEqual([
      'JSII8007: Interface contains behavior. Rename "Greeter" to "IGreeter"',
    ]);
  });
});

describe('structs', () => {
  const source = `
    export interface Options {
      /** The name. */
      readonly name: string;
      readonly count?: number;
      readonly tags?: string[];
    }
    export interface MoreOptions extends Options {
      readonly extra: boolean;
    }
  `;

  test('an interface with only readonly properties and no "I" prefix is a struct', () => {
    expect(interfaceOf(source, 'Options').datatype).toBe(true);
  });

  test('its properties are immutable, and can be optional', () => {
    expect(interfaceOf(source, 'Options').properties).toMatchObject([
      { name: 'name', immutable: true, abstract: true, type: { primitive: 'string' } },
      { name: 'count', immutable: true, optional: true, type: { primitive: 'number' } },
      {
        name: 'tags',
        immutable: true,
        optional: true,
        type: { collection: { kind: 'array', elementtype: { primitive: 'string' } } },
      },
    ]);
  });

  test('the documentation of a property is part of the assembly', () => {
    expect(interfaceOf(source, 'Options').properties?.[0].docs).toEqual({ summary: 'The name.' });
  });

  test('a struct can extend another struct', () => {
    const more = interfaceOf(source, 'MoreOptions');

    expect(more.datatype).toBe(true);
    expect(more.interfaces).toEqual(['testpkg.Options']);
    expect(more.properties?.map((p) => p.name)).toEqual(['extra']);
  });

  test('a struct can be used as a method parameter', () => {
    const klass = typeOf<spec.ClassType>(
      `${source}\nexport class Klass { public configure(_options: Options): void {} }`,
      'Klass',
      spec.TypeKind.Class,
    );

    expect(klass.methods?.[0].parameters).toEqual([{ name: '_options', type: { fqn: 'testpkg.Options' } }]);
  });

  test('a struct can contain other structs and enums', () => {
    const nested = interfaceOf(
      `
        export enum Mode { FAST, SLOW }
        export interface Inner { readonly value: string }
        export interface Outer { readonly inner: Inner; readonly mode?: Mode; readonly inners: Inner[] }
      `,
      'Outer',
    );

    expect(nested.properties).toMatchObject([
      { name: 'inner', type: { fqn: 'testpkg.Inner' } },
      { name: 'inners', type: { collection: { kind: 'array', elementtype: { fqn: 'testpkg.Inner' } } } },
      { name: 'mode', optional: true, type: { fqn: 'testpkg.Mode' } },
    ]);
  });

  test('a mutable property is an error, unless the interface is renamed with the "I" prefix', () => {
    expect(compileForDiagnostics('export interface Options { value: string }')).toEqual([
      'JSII3008: The "value" property of struct "testpkg.Options" must be "readonly". Rename "testpkg.Options" to "IOptions" if it is meant to be a behavioral interface.',
    ]);
  });
});

describe('@struct', () => {
  test('makes an interface with methods and the "I" prefix a struct', () => {
    const type = interfaceOf(
      `
        /** @struct */
        export interface IOptions { readonly value: string }
      `,
      'IOptions',
    );

    expect(type.datatype).toBe(true);
  });
});

describe('enums', () => {
  test('members are listed in declaration order', () => {
    const color = enumOf('export enum Color { RED, GREEN, BLUE }', 'Color');

    expect(color.members.map((m) => m.name)).toEqual(['RED', 'GREEN', 'BLUE']);
  });

  test('members can have documentation', () => {
    const color = enumOf(
      `
        export enum Color {
          /** The color of fire. */
          RED,
          GREEN,
        }
      `,
      'Color',
    );

    expect(color.members[0].docs).toEqual({ summary: 'The color of fire.' });
    expect(color.members[1].docs).toBeUndefined();
  });

  test('an enum can be used as the type of a property or parameter', () => {
    const klass = typeOf<spec.ClassType>(
      `
        export enum Color { RED, GREEN }
        export class Klass {
          public color: Color = Color.RED;
          public paint(_color?: Color): void {}
        }
      `,
      'Klass',
      spec.TypeKind.Class,
    );

    expect(klass.properties?.[0].type).toEqual({ fqn: 'testpkg.Color' });
    expect(klass.methods?.[0].parameters).toEqual([{ name: '_color', optional: true, type: { fqn: 'testpkg.Color' } }]);
  });
});
