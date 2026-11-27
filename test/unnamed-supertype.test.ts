import { compileJsiiForErrors } from './compiler-helpers';

test('an unnamed base class produces a diagnostic instead of an internal error', () => {
  const errors = compileJsiiForErrors(`
    declare function make(): new () => object;
    export class Derived extends make() {}
  `);

  expect(errors).toEqual([expect.stringMatching(/Illegal extends clause.*unnamed base type/)]);
});
