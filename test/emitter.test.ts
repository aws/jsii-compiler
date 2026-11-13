import { injectRtti, rttiSnippet } from '../src/emitter';

// Unit tests for the pure helpers of the emitter (runtime type information injection).

describe('rtti injection', () => {
  const snippet = rttiSnippet([{ name: 'Bucket', fqn: 'pkg.Bucket' }], '1.2.3');

  test('snippet declares the jsii.rtti symbol with fqn and version', () => {
    expect(snippet).toContain('Symbol.for("jsii.rtti")');
    expect(snippet).toContain('"pkg.Bucket"');
    expect(snippet).toContain('"1.2.3"');
    expect(snippet).toContain('exports.Bucket');
  });

  test('appends at the end when there is no sourceMappingURL', () => {
    const out = injectRtti('"use strict";\nexports.Bucket = class {};\n', snippet);
    expect(out.endsWith(snippet)).toBe(true);
  });

  test('inserts before a trailing sourceMappingURL comment', () => {
    const source = '"use strict";\nexports.Bucket = class {};\n//# sourceMappingURL=bucket.js.map\n';
    const out = injectRtti(source, snippet);
    const lines = out.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toBe('//# sourceMappingURL=bucket.js.map');
    expect(out).toContain('Symbol.for("jsii.rtti")');
    expect(out.indexOf('jsii.rtti')).toBeLessThan(out.indexOf('sourceMappingURL'));
  });
});
