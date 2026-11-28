import { Code } from '../../../src/jsii-diagnostic';

describe('Code registration', () => {
  test('rejects a duplicate code', () => {
    Code.error({ code: 987101, name: 'test-only/registry-duplicate-code', formatter: () => 'x' });

    expect(() => Code.error({ code: 987101, name: 'test-only/registry-other-name', formatter: () => 'x' })).toThrow(
      'Attempted to create two instances of Code with code 987101',
    );
  });

  test('accepts a code that is a property name of the registry', () => {
    // `in` used to look at the properties of the Map rather than at its entries, so this threw.
    expect(() =>
      Code.error({ code: 'size' as any, name: 'test-only/code-as-property', formatter: () => 'x' }),
    ).not.toThrow();
  });
});
