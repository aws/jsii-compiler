import { DiagnosticCategory } from 'typescript';

import { compileJsiiForTest } from '../src';
import { errors, warnings } from './compiler-helpers';
import { configureCategories, JsiiDiagnostic } from '../src/jsii-diagnostic';

afterEach(() => {
  configureCategories({ JSII4011: DiagnosticCategory.Warning });
});

test('an unknown target language in package.json is passed through with a warning', () => {
  const result = compileJsiiForTest('export class Foo { }', {
    captureDiagnostics: true,
    packageJson: { jsii: { targets: { rust: { package: 'my-crate' } } } },
  });

  expect(errors(result.diagnostics)).toEqual([]);
  expect(warnings(result.diagnostics)).toContainEqual(
    expect.stringMatching(/Unknown target language "rust" in "package\.json"/),
  );
  expect(result.assembly?.targets?.rust).toEqual({ package: 'my-crate' });
});

test('built-in target languages produce no warning', () => {
  const result = compileJsiiForTest('export class Foo { }', {
    captureDiagnostics: true,
    packageJson: { jsii: { targets: { python: { module: 'testpkg', distName: 'testpkg' } } } },
  });

  expect(result.diagnostics.filter((d) => d.code === JsiiDiagnostic.JSII_4011_UNKNOWN_TARGET_LANGUAGE.code)).toEqual(
    [],
  );
});

test('the warning can be raised to an error, so a typo still fails the build', () => {
  configureCategories({ JSII4011: DiagnosticCategory.Error });

  const result = compileJsiiForTest('export class Foo { }', {
    captureDiagnostics: true,
    packageJson: { jsii: { targets: { pyhton: { module: 'testpkg' } } } },
  });

  expect(errors(result.diagnostics)).toContainEqual(expect.stringMatching(/Unknown target language "pyhton"/));
});
