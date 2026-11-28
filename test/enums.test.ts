import { EnumType } from '@jsii/spec';

import { sourceToAssemblyHelper } from '../lib';
import { compileJsiiForErrors } from './compiler-helpers';

// ----------------------------------------------------------------------
test('test parsing enum with two members and no values', () => {
  const assembly = sourceToAssemblyHelper(`
    export enum Foo {
      BAR,
      BAZ
    }
  `);

  expect(assembly.types!['testpkg.Foo']).toEqual({
    assembly: 'testpkg',
    fqn: 'testpkg.Foo',
    kind: 'enum',
    members: [{ name: 'BAR' }, { name: 'BAZ' }],
    locationInModule: { filename: 'index.ts', line: 2 },
    name: 'Foo',
    symbolId: 'index:Foo',
  });
});

// ----------------------------------------------------------------------
test('test parsing enum with two members and assigned values', () => {
  const assembly = sourceToAssemblyHelper(`
    export enum Foo {
      BAR = 'Bar',
      BAZ = 'Baz'
    }
  `);

  expect(assembly.types!['testpkg.Foo']).toEqual({
    assembly: 'testpkg',
    fqn: 'testpkg.Foo',
    kind: 'enum',
    members: [{ name: 'BAR' }, { name: 'BAZ' }],
    locationInModule: { filename: 'index.ts', line: 2 },
    name: 'Foo',
    symbolId: 'index:Foo',
  });
});

// ----------------------------------------------------------------------

test('enums can have a mix of letters and number', () => {
  const assembly = sourceToAssemblyHelper(`
    export enum Foo {
      Q5X,
      IB3M,
    }
  `);

  expect((assembly.types!['testpkg.Foo'] as EnumType).members).toEqual([{ name: 'Q5X' }, { name: 'IB3M' }]);
});

test('enums with the same assigned value should fail', () => {
  expect(
    compileJsiiForErrors(`
    export enum Foo {
      BAR = 'Bar',
      BAR_DUPE = 'Bar',
      BAZ = 'Baz',
      BAZ_DUPE = 'Baz',
    }
  `),
  ).toContainEqual(expect.stringMatching(/Value 'Bar' is used for multiple enum values: BAR, BAR_DUPE/));
});

// ----------------------------------------------------------------------
test.each([
  [
    'written differently',
    'ON = 1, LEGACY_ON = 0x1, OFF = 2',
    'Value 1 is used for multiple enum values: ON, LEGACY_ON',
  ],
  ['implicit and explicit', 'OFF, ON, LEGACY_OFF = 0', 'Value 0 is used for multiple enum values: OFF, LEGACY_OFF'],
  ['implicit after explicit', 'A = 1, B, C = 2', 'Value 2 is used for multiple enum values: B, C'],
  ['computed', 'ON = 1, LEGACY_ON = ON, OFF = 2', 'Value 1 is used for multiple enum values: ON, LEGACY_ON'],
  [
    'string with other quotes',
    'ON = "on", LEGACY_ON = \'on\'',
    "Value 'on' is used for multiple enum values: ON, LEGACY_ON",
  ],
])('reject duplicate enum values (%s)', (_, members, message) => {
  expect(compileJsiiForErrors(`export enum State { ${members} }`)).toEqual([message]);
});

// ----------------------------------------------------------------------
test('accept a number and a string with the same text as enum values', () => {
  const assembly = sourceToAssemblyHelper(`
    export enum State {
      ONE = 1,
      ONE_STRING = '1',
    }
  `);

  expect((assembly.types!['testpkg.State'] as EnumType).members).toEqual([{ name: 'ONE' }, { name: 'ONE_STRING' }]);
});
