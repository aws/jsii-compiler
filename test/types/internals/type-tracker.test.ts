import * as ts from 'typescript';

import { TypeTracker } from '../../../src/type-tracker';

function enumDeclaration(source: string): ts.EnumDeclaration {
  const sf = ts.createSourceFile('test.ts', source, ts.ScriptTarget.ES2020, true);
  const decl = sf.statements.find(ts.isEnumDeclaration);
  if (!decl) {
    throw new Error('No enum in test source');
  }
  return decl;
}

describe('TypeTracker', () => {
  test('returns the registered enum declaration', () => {
    const tracker = new TypeTracker();
    const decl = enumDeclaration('enum Color { Red, Green }');
    tracker.registerEnum('lib.Color', decl);

    expect(tracker.getEnum('lib.Color')).toBe(decl);
  });

  test('throws when asking for an enum that was never registered', () => {
    const tracker = new TypeTracker();

    expect(() => tracker.getEnum('lib.Missing')).toThrow('No declaration was registered for enum lib.Missing');
    expect(() => tracker.getEnumMembers('lib.Missing')).toThrow('No declaration was registered for enum lib.Missing');
  });

  test('returns enum members keyed by name', () => {
    const tracker = new TypeTracker();
    tracker.registerEnum('lib.Color', enumDeclaration('enum Color { Red, Green = "green" }'));

    const members = tracker.getEnumMembers('lib.Color');

    expect(Object.keys(members)).toEqual(['Red', 'Green']);
    expect(members.Green.initializer?.getText()).toBe('"green"');
  });

  test('returns an enum member named by a string literal under its text', () => {
    const tracker = new TypeTracker();
    tracker.registerEnum('lib.Quoted', enumDeclaration('enum Quoted { PLAIN = 0, "QUOTED" = 1 }'));

    expect(Object.keys(tracker.getEnumMembers('lib.Quoted'))).toEqual(['PLAIN', 'QUOTED']);
  });

  test('throws a readable error for an enum member with a computed name', () => {
    const tracker = new TypeTracker();
    tracker.registerEnum('lib.Computed', enumDeclaration('enum Computed { ["A"] = 1 }'));

    expect(() => tracker.getEnumMembers('lib.Computed')).toThrow(
      'Expected an identifier or a string literal, got ComputedPropertyName',
    );
  });
});
