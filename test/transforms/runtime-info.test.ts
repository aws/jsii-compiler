import { compileJsiiForTest } from '../../lib';

// The runtime type information (`Symbol.for("jsii.rtti")` on each exported class) used to be injected by a
// TypeScript transformer during emit. The TypeScript 7 API has no transformer hook, so the compiler injects it
// into the emitted JavaScript after the emit (see src/emitter.ts). These tests check the emitted files end to end:
// the injected code is loaded and the marker is read back the way the jsii runtime does.

const RTTI = Symbol.for('jsii.rtti');

test('leaves files without classes unaltered', () => {
  const files = compile({ 'index.ts': 'export const n = 1;' });
  expect(files['index.js']).not.toContain('jsii.rtti');
});

test('adds runtime info for a class', () => {
  const exports = load(compile({ 'index.ts': 'export class Foo {}' }));
  expect(exports.Foo[RTTI]).toEqual({ fqn: 'testpkg.Foo', version: '0.0.1' });
});

test('adds runtime info for each class', () => {
  const exports = load(compile({ 'index.ts': 'export class Foo {}\nexport class Bar {}' }));
  expect(exports.Foo[RTTI]).toEqual({ fqn: 'testpkg.Foo', version: '0.0.1' });
  expect(exports.Bar[RTTI]).toEqual({ fqn: 'testpkg.Bar', version: '0.0.1' });
});

test('skips runtime info for classes that are not part of the assembly', () => {
  const exports = load(
    compile({
      'index.ts': ['export class Foo {}', '/** @internal */', 'export class _Hidden {}'].join('\n'),
    }),
  );
  expect(exports.Foo[RTTI]).toEqual({ fqn: 'testpkg.Foo', version: '0.0.1' });
  expect(exports._Hidden[RTTI]).toBeUndefined();
});

test('injects into every file that declares classes, with the file-local export names', () => {
  const files = compile({
    'index.ts': 'export * from "./other";\nexport class Foo {}',
    'other.ts': 'export class Other {}',
  });
  expect(load(files, 'index.js').Foo[RTTI]).toEqual({ fqn: 'testpkg.Foo', version: '0.0.1' });
  expect(load(files, 'other.js').Other[RTTI]).toEqual({ fqn: 'testpkg.Other', version: '0.0.1' });
});

test('does not clash with existing names in the module', () => {
  // The previous transformer declared a `JSII_RTTI_SYMBOL_<n>` constant and had to pick a unique name; the
  // injected code declares nothing, so a module using that name is unaffected.
  const exports = load(
    compile({
      'index.ts': 'const JSII_RTTI_SYMBOL_1 = 42;\nexport const taken = JSII_RTTI_SYMBOL_1;\nexport class Foo {}',
    }),
  );
  expect(exports.taken).toBe(42);
  expect(exports.Foo[RTTI]).toEqual({ fqn: 'testpkg.Foo', version: '0.0.1' });
});

test('keeps the sourceMappingURL comment as the last line of the file', () => {
  const js = compile({ 'index.ts': 'export class Foo {}' })['index.js'];
  const lines = js.trimEnd().split('\n');
  expect(lines[lines.length - 1]).toMatch(/^\/\/# sourceMappingURL=/);
  expect(js.indexOf('jsii.rtti')).toBeLessThan(js.indexOf('//# sourceMappingURL='));
});

function compile(source: { 'index.ts': string; [name: string]: string }): Record<string, string> {
  return compileJsiiForTest(source).files;
}

/** Evaluate an emitted CommonJS file (without its relative imports) and return its `exports`. */
function load(files: Record<string, string>, fileName = 'index.js'): any {
  const exports: any = {};
  const module = { exports };
  // Relative imports are not needed to read the markers of the file's own classes; stub them out.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const requireStub = (id: string) => (id.startsWith('.') ? {} : require(id));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-require-imports
  new Function('exports', 'require', 'module', files[fileName])(exports, requireStub, module);
  return module.exports;
}
