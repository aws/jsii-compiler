import { compileJsiiForErrors } from './compiler-helpers';

// @TODO(ts7): expects a jsii validation diagnostic (JSII3004); re-enable with the port of the validator
test.skip('an unnamed base class produces a diagnostic instead of an internal error', () => {
  const errors = compileJsiiForErrors(`
    declare function make(): new () => object;
    export class Derived extends make() {}
  `);

  expect(errors).toEqual([expect.stringMatching(/Illegal extends clause.*unnamed base type/)]);
});
