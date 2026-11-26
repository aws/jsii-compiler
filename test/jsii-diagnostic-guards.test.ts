import { Code } from '../src/jsii-diagnostic';

// `Code` registers diagnostics in two `Map`s, and the constructor rejects duplicates with `x in map` checks.
// `in` looks at properties of the Map object itself (not at its entries), so these checks only fire when the code or
// name happens to be the name of a property of the Map. See https://github.com/aws/jsii-compiler/issues/2947
describe('Code duplicate detection', () => {
  const byCode: Map<number, Code> = (Code as any).byCode;
  const byName: Map<string, Code> = (Code as any).byName;

  afterEach(() => {
    delete (byCode as any)[987654];
    byCode.delete(987654);
    byName.delete('size');
    byName.delete('unique/name');
  });

  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2947
  test('rejects a name that is a property of the registry (and only those)', () => {
    expect(() => Code.error({ code: 987655, name: 'size', formatter: () => 'x' })).toThrow(
      'Attempted to create two instances of Code with name size',
    );
  });

  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2947
  test('rejects a code that is a property of the registry (and only those)', () => {
    (byCode as any)[987654] = 'a property, not an entry';

    expect(() => Code.error({ code: 987654, name: 'unique/name', formatter: () => 'x' })).toThrow(
      'Attempted to create two instances of Code with code 987654',
    );
  });
});
