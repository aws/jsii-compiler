import { Code } from '../../../src/jsii-diagnostic';

describe('Code registration', () => {
  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2947
  // The constructor checks `code in Code.byCode`, which looks at the properties of the Map that holds the diagnostics,
  // not at its entries. Only a code that is the name of such a property (which a number never is) is rejected.
  test('rejects a code that is a property of the registry', () => {
    expect(() => Code.error({ code: 'size' as any, name: 'test-only/code-as-property', formatter: () => 'x' })).toThrow(
      'Attempted to create two instances of Code with code size',
    );
  });
});
