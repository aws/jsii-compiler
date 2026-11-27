import { compileJsiiForDiagnostics } from '../compiler-helpers';

describe('JSII7000 documentation/non-existent-parameter', () => {
  test('is reported when @param refers to a parameter the method does not have', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export class Klass {
        /**
         * Does a thing.
         *
         * @param doesNotExist this parameter is not part of the signature
         */
        public method(actual: string) {
          return actual;
        }
      }
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 7000,
        messageText: 'Documentation for method "method" refers to non-existent @param "doesNotExist"',
      }),
    );
  });

  test('is not reported when every @param exists', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      export class Klass {
        /**
         * @param actual the parameter
         */
        public method(actual: string) {
          return actual;
        }
      }
    `);

    expect(diagnostics.map((d) => d.jsiiCode)).not.toContain(7000);
  });
});

describe('JSII7999 documentation/documentation-error', () => {
  test('is reported when a doc tag is malformed', () => {
    const diagnostics = compileJsiiForDiagnostics(`
      /** @deprecated */
      export class Klass {}
    `);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        jsiiCode: 7999,
        messageText: '@deprecated tag needs a reason and/or suggested alternatives.',
      }),
    );
  });
});
