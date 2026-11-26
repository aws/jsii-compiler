import * as ts from 'typescript';

import { TypeTracker } from '../src/type-tracker';

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

  test('throws if an enum member is not named by an identifier', () => {
    const tracker = new TypeTracker();
    tracker.registerEnum('lib.Quoted', enumDeclaration('enum Quoted { "QUOTED" = 1 }'));

    // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2949
    // The intended error ("Expected identifier, got ...") is masked by a TypeError thrown by
    // JSON.stringify(), because AST nodes are circular structures.
    expect(() => tracker.getEnumMembers('lib.Quoted')).toThrow('Converting circular structure to JSON');
  });
});
