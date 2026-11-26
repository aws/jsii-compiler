import fc from 'fast-check';
import { Match, ObjectValidator, RuleSet, RuleType, ValidationError } from '../../src/tsconfig/validator';

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
    const arrayEl = anythingExceptUndefined();

    test('pass', () => {
      fc.assert(
        fc.property(
          fc
            .array(arrayEl)
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
          fc.uniqueArray(arrayEl, {
            minLength: 1,
          }),
          fc.array(arrayEl),
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

  describe('Match.TRUE', () => {
    test('pass', () => {
      expect(Match.TRUE(true)).toBe(true);
    });

    test('fail', () => {
      expect(Match.TRUE(false)).toBe(false);
    });
  });

  describe('Match.FALSE', () => {
    test('pass', () => {
      expect(Match.FALSE(false)).toBe(true);
    });

    test('fail', () => {
      expect(Match.FALSE(true)).toBe(false);
    });
  });

  describe('Match.MISSING', () => {
    test('pass', () => {
      expect(Match.MISSING(undefined)).toBe(true);
      expect(Match.MISSING(null)).toBe(true);
    });

    test('fail', () => {
      fc.assert(
        fc.property(
          fc.anything().filter((v) => !(v === undefined || v === null)),
          (actual) => {
            return !Match.MISSING(actual);
          },
        ),
      );
    });
  });
});

describe('Match.eq', () => {
  test('is false (rather than throwing) for values that cannot be compared', () => {
    const uncomparable = Object.assign(() => undefined, {
      [Symbol.toPrimitive]: () => {
        throw new Error('cannot be converted');
      },
    });

    expect(Match.eq(uncomparable)('text')).toBe(false);
  });
});

describe('Rule Set', () => {
  const ruleSet = (options?: ConstructorParameters<typeof RuleSet>[0]) => {
    const rules = new RuleSet(options);
    rules.shouldPass('mustBeTrue', Match.TRUE);
    rules.shouldPass('mayBeTrue', Match.optional(Match.TRUE));
    rules.shouldFail('mustNotBeMissing', Match.MISSING);
    rules.shouldFail('mustNotBeTrue', Match.TRUE);
    return rules;
  };

  test('lists the fields it has rules for', () => {
    expect(ruleSet().fields).toEqual(['mustBeTrue', 'mayBeTrue', 'mustNotBeMissing', 'mustNotBeTrue']);
  });

  test('allows any field when unexpected fields are not rejected', () => {
    expect(ruleSet({ unexpectedFields: RuleType.PASS }).allowedFields).toBeUndefined();
  });

  test('only allows the fields it has rules for when unexpected fields are rejected', () => {
    expect(ruleSet({ unexpectedFields: RuleType.FAIL }).allowedFields).toEqual([
      'mustBeTrue',
      'mayBeTrue',
      'mustNotBeMissing',
      'mustNotBeTrue',
    ]);
  });

  test('requires the fields that cannot be absent', () => {
    expect(ruleSet().requiredFields).toEqual(['mustBeTrue', 'mustNotBeMissing']);
  });

  test('ignores rules of an unknown type when looking for required fields', () => {
    const rules = ruleSet();
    rules.rules.push({ field: 'unknown', matcher: Match.ANY, type: 'unknown' as RuleType });

    expect(rules.requiredFields).toEqual(['mustBeTrue', 'mustNotBeMissing']);
  });

  test('imports the rules of another rule set', () => {
    const rules = new RuleSet();
    rules.import(ruleSet());

    expect(rules.fields).toEqual(ruleSet().fields);
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

  const rules = () => {
    const ruleSet = new RuleSet({ unexpectedFields: RuleType.FAIL });
    ruleSet.shouldPass('mustBeTrue', Match.TRUE);
    ruleSet.shouldFail('mustNotBeTrue', Match.TRUE);
    return ruleSet;
  };

  const violationsOf = (ruleSet: RuleSet, data: object) => {
    try {
      new ObjectValidator(ruleSet).validate(data);
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      return (error as ValidationError).violations;
    }
    return [];
  };

  test('accepts data that satisfies all rules', () => {
    expect(violationsOf(rules(), { mustBeTrue: true, mustNotBeTrue: false })).toEqual([]);
  });

  test('reports a PASS rule that does not match', () => {
    expect(violationsOf(rules(), { mustBeTrue: false })).toEqual([expect.objectContaining({ field: 'mustBeTrue' })]);
  });

  test('reports a FAIL rule that matches', () => {
    expect(violationsOf(rules(), { mustBeTrue: true, mustNotBeTrue: true })).toEqual([
      expect.objectContaining({ field: 'mustNotBeTrue' }),
    ]);
  });

  test('reports unexpected fields when they are not allowed', () => {
    expect(violationsOf(rules(), { mustBeTrue: true, other: 1 })).toEqual([
      expect.objectContaining({ field: 'other' }),
    ]);
  });

  test('ignores rules of an unknown type', () => {
    const ruleSet = rules();
    ruleSet.rules.push({ field: 'unknown', matcher: () => false, type: 'unknown' as RuleType });

    expect(violationsOf(ruleSet, { mustBeTrue: true })).toEqual([]);
  });
});

function anythingExceptUndefined() {
  return fc.anything().filter((x) => x !== undefined);
}
