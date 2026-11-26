import { compileForDiagnostics } from './helpers';

describe('JSII3999 type-model/incoherent-type-model', () => {
  // Places that take a type but cannot express that the value is optional.
  test.each([
    { where: 'the type of a promise', type: 'Promise<string | undefined>', body: 'return Promise.resolve(undefined);' },
    { where: 'the element type of an array', type: 'Array<string | undefined>', body: 'return [];' },
  ])('is reported for an optional value as $where', ({ type, body }) => {
    expect(
      compileForDiagnostics(`
        export class Klass {
          public method(): ${type} {
            ${body}
          }
        }
      `),
    ).toEqual(['JSII3999: Encountered optional value in location where a plain type reference is expected']);
  });
});
