import { Sets } from '../src/sets';

describe('Sets.intersection', () => {
  test('returns an empty set when given no sets', () => {
    expect(Sets.intersection()).toEqual(new Set());
  });

  test('returns a copy of a single set', () => {
    const input = new Set([1, 2, 3]);
    const result = Sets.intersection(input);

    expect(result).toEqual(new Set([1, 2, 3]));
    expect(result).not.toBe(input);
  });

  test('returns only the elements present in all sets', () => {
    expect(Sets.intersection(new Set([1, 2, 3, 4]), new Set([2, 3, 4]), new Set([3, 4, 5]))).toEqual(new Set([3, 4]));
  });

  test('returns an empty set when sets are disjoint', () => {
    expect(Sets.intersection(new Set([1]), new Set([2]))).toEqual(new Set());
  });
});

describe('Sets.union', () => {
  test('returns an empty set when given no sets', () => {
    expect(Sets.union()).toEqual(new Set());
  });

  test('returns all elements of all sets without duplicates', () => {
    expect(Sets.union(new Set([1, 2]), new Set([2, 3]), new Set([4]))).toEqual(new Set([1, 2, 3, 4]));
  });
});

describe('Sets.diff', () => {
  test('returns elements of the first set absent from the second', () => {
    expect(Sets.diff(new Set([1, 2, 3]), new Set([2, 4]))).toEqual(new Set([1, 3]));
  });

  test('returns an empty set if the second set contains the first', () => {
    expect(Sets.diff(new Set([1, 2]), new Set([1, 2, 3]))).toEqual(new Set());
  });
});

describe('Sets.intersect', () => {
  test('yields the elements of the first set that are in the second', () => {
    expect(Array.from(Sets.intersect(new Set([1, 2, 3]), new Set([3, 2, 5])))).toEqual([2, 3]);
  });

  test('yields nothing for disjoint sets', () => {
    expect(Array.from(Sets.intersect(new Set([1]), new Set([2])))).toEqual([]);
  });
});
