import fc from 'fast-check';
import { Match, ObjectValidator, RuleSet } from '../../src/tsconfig/validator';

const expectViolation = (expectedMessage: string, expected: any, actual: any) => {
  return (message: string) => {
    expect(message).toMatch(expectedMessage);
    expect(message).toContain(String(JSON.stringify(expected))); // JSON.stringify might return undefined, force it as string
    expect(message).toContain(String(JSON.stringify(actual)));
  };
};

describe('Built-in matchers', () => {
  describe('Match.ANY', () => {
    test('pass', () => {
      fc.assert(
        fc.property(fc.anything(), (actual) => {
          return Match.ANY(actual);
        }),
      );
    });
  });

  describe('Match.oneOf', () => {
    test('pass', () => {
      fc.assert(
        fc.property(
          fc
            .array(fc.oneof(fc.string(), fc.integer(), fc.float()), {
              minLength: 1,
            })
            .chain((allowed) => fc.tuple(fc.constant(allowed), fc.constantFrom(...allowed))),
          ([allowed, actual]) => {
            return Match.oneOf(...allowed)(actual);
          },
        ),
      );
    });
    test('fail', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.oneof(fc.string(), fc.integer(), fc.float()), {
            minLength: 1,
          }),
          (possible) => {
            const allowed = possible.slice(0, -1);
            const actual = possible.at(-1);
            return !Match.oneOf(...allowed)(actual, {
              reporter: expectViolation('Expected value to be one of', allowed, actual),
            });
          },
        ),
      );
    });
  });

  describe('Match.eq', () => {
    test('pass', () => {
      fc.assert(
        fc.property(fc.anything(), (value) => {
          return Match.eq(value)(value);
        }),
      );
    });
    test('fail', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(
            // Need to remove empty arrays here as they are equal to each other
            fc.anything(),
            {
              minLength: 2,
              maxLength: 2,
              // mimic what the matcher does
              // this uses loose equality, while catching any not comparable values
              comparator: (a, b) => {
                try {
                  return a == b || Match.arrEq(a as any)(b);
                } catch {
                  return false;
                }
              },
            },
          ),
          ([expected, actual]) => {
            const keyword = Array.isArray(expected) ? 'array' : 'value';
            return !Match.eq(expected)(actual, { reporter: expectViolation(`Expected ${keyword}`, expected, actual) });
          },
        ),
      );
    });
  });

  describe('Match.arrEq', () => {
    test('pass', () => {
      fc.assert(
        fc.property(
          fc
            .array(fc.anything({ maxDepth: 0 }))
            .chain((expected) =>
              fc.tuple(
                fc.constant(expected),
                fc.shuffledSubarray(expected, { minLength: expected.length, maxLength: expected.length }),
              ),
            ),
          ([expected, actual]) => {
            return Match.arrEq(expected)(actual);
          },
        ),
      );
    });
    test('fail', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.anything(), {
            minLength: 1,
          }),
          fc.array(fc.anything()),
          (possible, actualBase) => {
            const expected = possible.slice(0, -1);
            const actual = [...actualBase, possible.at(-1)];
            return !Match.arrEq(expected)(actual, {
              reporter: expectViolation('Expected array matching', expected, actual),
            });
          },
        ),
      );
    });
  });

  describe('Match.strEq case sensitive', () => {
    test('pass', () => {
      fc.assert(
        fc.property(fc.string(), (value) => {
          return Match.strEq(value, true)(value);
        }),
      );
    });
    test('fail', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.string(), {
            minLength: 2,
            maxLength: 2,
          }),
          ([expected, actual]) => {
            return !Match.strEq(expected, true)(actual, {
              reporter: expectViolation('Expected string', expected, actual),
            });
          },
        ),
      );
    });
  });

  describe('Match.strEq case insensitive', () => {
    test('pass', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }).chain((s) => fc.tuple(fc.constant(s), fc.mixedCase(fc.constant(s)))),
          ([expected, actual]) => {
            return Match.strEq(expected, false)(actual);
          },
        ),
      );
    });
    test('fail', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.string(), {
            minLength: 2,
            maxLength: 2,
          }),
          ([expected, actual]) => {
            return !Match.strEq(expected, true)(actual, {
              reporter: expectViolation('Expected string', expected, actual),
            });
          },
        ),
      );
    });
  });
});

describe('Object Validator', () => {
  test('throws for non objects', () => {
    fc.assert(
      fc.property(fc.oneof(fc.anything({ maxDepth: 0 }), fc.array(fc.anything())), (data: any) => {
        const validator = new ObjectValidator(new RuleSet(), 'testData');
        expect(() => validator.validate(data)).toThrow('Provided data must be an object');
      }),
    );
  });
});
