import { Match, ObjectValidator, RuleSet, RuleType, ValidationError } from '../../../src/tsconfig/validator';

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
    rules.rules.push({ field: 'unknown', matcher: Match.ANY, type: 'unknown' as unknown as RuleType });

    expect(rules.requiredFields).toEqual(['mustBeTrue', 'mustNotBeMissing']);
  });

  test('imports the rules of another rule set', () => {
    const rules = new RuleSet();
    rules.import(ruleSet());

    expect(rules.fields).toEqual(ruleSet().fields);
  });
});

describe('Object Validator rules', () => {
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

  describe('the message of a FAIL rule', () => {
    const messageOf = (matcher: (actual: any) => boolean, value: unknown) => {
      const ruleSet = new RuleSet();
      ruleSet.shouldFail('field', matcher);
      return violationsOf(ruleSet, { field: value })[0].message;
    };

    test('names the value that the matcher rejects', () => {
      expect(messageOf(Match.eq('es5'), 'es5')).toBe('Expected value not to be "es5", got: "es5"');
    });

    test('names the values that the matcher rejects', () => {
      expect(messageOf(Match.oneOf('amd', 'umd'), 'amd')).toBe(
        'Expected value not to be one of ["amd","umd"], got: "amd"',
      );
    });

    test('falls back to a general message when the matcher does not say what it rejects', () => {
      expect(messageOf((actual) => actual === 1, 1)).toBe('Value is not allowed, got: 1');
    });
  });

  test('reports unexpected fields when they are not allowed', () => {
    expect(violationsOf(rules(), { mustBeTrue: true, other: 1 })).toEqual([
      expect.objectContaining({ field: 'other' }),
    ]);
  });

  test('ignores rules of an unknown type', () => {
    const ruleSet = rules();
    ruleSet.rules.push({ field: 'unknown', matcher: () => false, type: 'unknown' as unknown as RuleType });

    expect(violationsOf(ruleSet, { mustBeTrue: true })).toEqual([]);
  });
});
