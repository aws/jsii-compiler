import { isInterfaceName, isStdlibDeclPath, splitSummary } from '../src/ts7/assembler';
import { isTs7BackendEnabled, TS7_BACKEND_ENV } from '../src/ts7/env';
import { injectRtti, rttiSnippet } from '../src/ts7/ts7-emit';

// Toolchain-free unit tests for the pure logic of the experimental ts7 backend.

describe('ts7 backend selection', () => {
  const original = process.env[TS7_BACKEND_ENV];
  afterEach(() => {
    if (original === undefined) {
      delete process.env[TS7_BACKEND_ENV];
    } else {
      process.env[TS7_BACKEND_ENV] = original;
    }
  });

  test('disabled by default', () => {
    delete process.env[TS7_BACKEND_ENV];
    expect(isTs7BackendEnabled()).toBe(false);
  });

  test('enabled by JSII_COMPILER_BACKEND=ts7 (case-insensitive)', () => {
    process.env[TS7_BACKEND_ENV] = 'TS7';
    expect(isTs7BackendEnabled()).toBe(true);
  });
});

describe('isInterfaceName (port of the classic Assembler rule)', () => {
  test.each([
    ['IBucket', true],
    ['IAMUser', true], // second char uppercase, even though third is uppercase too
    ['IDs', true],
    ['IonicColumnProps', false], // second char lowercase: not a behavioral name
    ['Bucket', false],
    ['I', false], // too short
  ])('%s -> %s', (name, expected) => {
    expect(isInterfaceName(name)).toBe(expected);
  });
});

describe('isStdlibDeclPath', () => {
  test.each([
    ['/toolchain/node_modules/lib/lib.es2022.d.ts', true],
    ['lib.dom.d.ts', true],
    ['/project/src/lib.foo.ts', false], // not a .d.ts
    ['/project/src/mylib.es5.d.ts', false], // must be exactly `lib.` after a separator
    ['/project/src/tag-lib.something.d.ts', false],
  ])('%s -> %s', (declPath, expected) => {
    expect(isStdlibDeclPath(declPath)).toBe(expected);
  });
});

describe('splitSummary (port of jsii docs.ts)', () => {
  test('single sentence gains a terminal period', () => {
    expect(splitSummary('Creates a bucket')).toEqual({ summary: 'Creates a bucket.', remarks: undefined });
  });

  test('first sentence becomes summary, rest becomes remarks', () => {
    expect(splitSummary('Creates a bucket. It is encrypted by default.')).toEqual({
      summary: 'Creates a bucket.',
      remarks: 'It is encrypted by default.',
    });
  });

  test('semicolon counts as terminal punctuation', () => {
    expect(splitSummary('the resource type;\nex: `AWS::S3::Bucket`')).toEqual({
      summary: 'the resource type;',
      remarks: 'ex: `AWS::S3::Bucket`',
    });
  });

  test('short first paragraph wins over the sentence split', () => {
    expect(splitSummary('A short title\n\nLonger body. With sentences.')).toEqual({
      summary: 'A short title.',
      remarks: 'Longer body. With sentences.',
    });
  });

  test('empty input produces no docs', () => {
    expect(splitSummary('')).toEqual({});
  });
});

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
