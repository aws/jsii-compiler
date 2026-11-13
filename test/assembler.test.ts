import { isInterfaceName, isStdlibDeclPath, splitSummary } from '../src/assembler';

// Unit tests for the pure helpers of the assembler.

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
