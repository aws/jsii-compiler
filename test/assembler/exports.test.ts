import { compileForDiagnostics } from './helpers';

// Broken re-exports are TypeScript errors. The assembler leaves reporting them to tsc.
describe('re-exports that TypeScript cannot resolve', () => {
  test('"export { Name } from" a missing module only reports the TypeScript error', () => {
    expect(compileForDiagnostics("export { Name } from './missing';")).toEqual([
      "TS2307: Cannot find module './missing' or its corresponding type declarations.",
    ]);
  });

  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2952
  test('"export * as ns from" a missing module also fails with JSII9997', () => {
    expect(compileForDiagnostics("export * as ns from './missing';")).toEqual([
      expect.stringMatching(/^JSII9997: Unknown error: Cannot read properties of undefined \(reading 'flags'\)/),
      "TS2307: Cannot find module './missing' or its corresponding type declarations.",
    ]);
  });

  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2952
  test('"export * as ns from" a module specifier that is not a string also fails with JSII9997', () => {
    expect(compileForDiagnostics('export * as ns from specifier;')).toEqual([
      expect.stringMatching(/^JSII9997: Unknown error: Cannot read properties of undefined \(reading 'flags'\)/),
      'TS1141: String literal expected.',
    ]);
  });
});
