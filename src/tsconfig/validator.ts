/**
 * A function that receives 3 arguments and validates if the provided value matches.
 * @param value The value to validate
 * @params options Additional options to influence the matcher behavior.
 * @returns true if the value matches
 */
type Matcher = (value: any, options?: MatcherOptions) => boolean;

interface MatcherOptions {
  /**
   * A function that will be called by the matcher with a a violation message.
   * This function is always called, regardless of the outcome of the matcher.
   * It is up to the caller of the matcher to decide if the message should be used or not.
   *
   * @param message The message describing the possible failure.
   */
  reporter?: (message: string) => void;
  /**
   * A function that might receive explicitly allowed values.
   * This can be used to generate synthetics values that would match the matcher.
   * It is not guaranteed that hints are received or that hints are complete.
   *
   * @param allowed The list values that a matcher offers as definitely allowed.
   */
  hints?: (allowed: any[]) => void;
}

export enum RuleType {
  PASS,
  FAIL,
}

export interface RuleSetOptions {
  /**
   * Defines the behavior for any encountered fields for which no rules are defined.
   * The default is to pass these fields without validation,
   * but this can also be set to fail any unexpected fields.
   *
   * @default RuleType.PASS
   */
  readonly unexpectedFields: RuleType;
}

interface Rule {
  field: string;
  type: RuleType;
  matcher: Matcher;
}

export class RuleSet {
  private _rules: Array<Rule> = [];
  public get rules(): Array<Rule> {
    return this._rules;
  }

  /**
   * Return all fields for which a rule exists
   */
  public get fields(): Array<string> {
    return [...new Set(this._rules.map((r) => r.field))];
  }

  /**
   * Return a list of fields that are allowed, or undefined if all are allowed.
   */
  public get allowedFields(): Array<string> | undefined {
    if (this.options.unexpectedFields === RuleType.FAIL) {
      return this.fields;
    }

    return undefined;
  }

  /**
   * Find all required fields by evaluating every rule in th set against undefined.
   * If the rule fails, the key must be required.
   *
   * @returns A list of keys that must be included or undefined
   */
  public get requiredFields(): Array<string> {
    const required: string[] = [];

    for (const rule of this._rules) {
      const key = rule.field;
      const matcherResult = rule.matcher(undefined);

      switch (rule.type) {
        case RuleType.PASS:
          if (!matcherResult) {
            required.push(key);
          }
          break;
        case RuleType.FAIL:
          if (matcherResult) {
            required.push(key);
          }
          break;
        default:
          continue;
      }
    }

    return required;
  }

  public constructor(
    public readonly options: RuleSetOptions = {
      unexpectedFields: RuleType.PASS,
    },
  ) {}

  /**
   * Requires the matcher to pass for the given field.
   * Otherwise a violation is detected.
   *
   * @param field The field the rule applies to
   * @param matcher The matcher function
   */
  public shouldPass(field: string, matcher: Matcher) {
    this._rules.push({ field, matcher, type: RuleType.PASS });
  }

  /**
   * Detects a violation if the matcher is matching for a certain field.
   *
   * @param field The field the rule applies to
   * @param matcher The matcher function
   */
  public shouldFail(field: string, matcher: Matcher) {
    this._rules.push({ field, matcher, type: RuleType.FAIL });
  }

  /**
   * Imports all rules from an other rule set.
   * Note that any options from the other rule set will be ignored.
   *
   * @param other The other rule set to import rules from.
   */
  public import(other: RuleSet) {
    this._rules.push(...other.rules);
  }

  /**
   * Records the field hints for the given rule set.
   * Hints are values that are guaranteed to pass the rule.
   * The list of hints is not guaranteed to be complete nor does it guarantee to return any values.
   * This can be used to create synthetic values for testing for error messages.
   *
   * @returns A record of fields and allowed values
   */
  public getFieldHints(): Record<string, any[]> {
    const fieldHints: Record<string, any[]> = {};

    for (const rule of this._rules) {
      // We are only interested in PASS rules here.
      // For FAILs we still don't know which values would pass.
      if (rule.type === RuleType.PASS) {
        // run the matcher to record hints
        rule.matcher(undefined, {
          hints: (receivedHints: any[]) => {
            // if we have recorded hints, add them to the map
            if (receivedHints) {
              fieldHints[rule.field] ??= [];
              fieldHints[rule.field].push(...receivedHints);
            }
          },
        });
      }
    }

    return fieldHints;
  }
}

/**
 * Helper to wrap a matcher with error reporting and hints
 */
function wrapMatcher(matcher: Matcher, message: (actual: any) => string, allowed?: any[]): Matcher {
  return (value, options) => {
    options?.reporter?.(message(value));
    if (allowed) {
      options?.hints?.(allowed);
    }
    return matcher(value);
  };
}

export class Match {
  /**
   * Value is optional, but if present should match
   */
  public static optional(matcher: Matcher): Matcher {
    return (value, options) => {
      if (value == null) {
        return true;
      }
      return matcher(value, options);
    };
  }

  /**
   * Value must be one of the allowed options
   */
  public static oneOf(...allowed: Array<string | number>): Matcher {
    return wrapMatcher(
      (actual) => allowed.includes(actual),
      (actual) => `Expected value to be one of ${JSON.stringify(allowed)}, got: ${JSON.stringify(actual)}`,
      allowed,
    );
  }

  /**
   * Value must be loosely equal to the expected value
   * Arrays are compared by elements
   */
  public static eq(expected: any): Matcher {
    return (actual, options) => {
      if (Array.isArray(expected)) {
        return Match.arrEq(expected)(actual, options);
      }

      try {
        options?.hints?.([expected]);
        options?.reporter?.(`Expected value ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
        return actual == expected;
      } catch {
        // some values cannot compared using loose quality, in this case the matcher just fails
        return false;
      }
    };
  }

  /**
   * Value must be loosely equal to the expected value
   * Arrays are compared by elements
   */
  public static arrEq(expected: any[]): Matcher {
    return wrapMatcher(
      (actual) => {
        try {
          // if both are arrays and of the same length, compare elements
          // if one of them is not, or they are a different length,
          // skip comparing elements as the the equality check later will fail
          if (Array.isArray(expected) && Array.isArray(actual) && expected.length == actual.length) {
            // compare all elements with loose typing
            return expected.every((e) => actual.some((a) => a == e));
          }

          // all other values and arrays of different shape
          return actual == expected;
        } catch {
          // some values cannot compared using loose quality, in this case the matcher just fails
          return false;
        }
      },
      (actual) => `Expected array matching ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`,
      [expected],
    );
  }

  /**
   * Compare strings, allows setting cases sensitivity
   */
  public static strEq(expected: string, caseSensitive = false): Matcher {
    return wrapMatcher(
      (actual) => {
        // case insensitive
        if (!caseSensitive && typeof actual === 'string') {
          return expected.toLowerCase() == actual.toLowerCase();
        }

        // case sensitive
        return actual == expected;
      },
      (actual: any) => `Expected string ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      [expected],
    );
  }

  /**
   * Allows any value
   */
  public static ANY: Matcher = (_val, _options) => true;

  // eslint-disable-next-line @typescript-eslint/member-ordering
  public static TRUE: Matcher = Match.eq(true);
  // eslint-disable-next-line @typescript-eslint/member-ordering
  public static FALSE: Matcher = Match.eq(false);

  /**
   * Missing (undefined) value
   */
  // eslint-disable-next-line @typescript-eslint/member-ordering
  public static MISSING = wrapMatcher(
    (actual) => actual === null || actual === undefined,
    (actual) => `Expected value to be present, got ${JSON.stringify(actual)}`,
    [undefined, null],
  );
}

export interface Violation {
  field: string;
  message: string;
}

export class ValidationError extends Error {
  constructor(public readonly violations: Violation[]) {
    // error message is a list of violations
    super('Data is invalid:\n' + violations.map((v) => v.field + ': ' + v.message).join('\n'));

    // Set the prototype explicitly.
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class ObjectValidator {
  public constructor(public ruleSet: RuleSet, private readonly dataName: string = 'data') {}

  /**
   * Validated the provided data against the set of rules.
   *
   * @throws when the data is invalid
   *
   * @param data the data to be validated
   */
  public validate(data: { [field: string]: any }) {
    // make sure data is an object
    if (!(typeof data === 'object' && !Array.isArray(data) && data !== null)) {
      throw new ValidationError([
        { field: this.dataName, message: 'Provided data must be an object, got: ' + JSON.stringify(data) },
      ]);
    }

    const checkedFields = new Set();
    const violations: Violation[] = [];

    // first check all defined rules
    for (const rule of this.ruleSet.rules) {
      const value = data[rule.field];

      // Use a fallback message, but allow the matcher to report a better arrow
      let violationMessage = 'Value is not allowed, got: ' + JSON.stringify(value);
      const matchResult = rule.matcher(value, {
        reporter: (message: string) => {
          violationMessage = message;
        },
      });

      switch (rule.type) {
        case RuleType.PASS:
          if (!matchResult) {
            violations.push({
              field: rule.field,
              message: violationMessage,
            });
          }
          break;
        case RuleType.FAIL:
          if (matchResult) {
            violations.push({
              field: rule.field,
              message: violationMessage,
            });
          }
          break;
        default:
          continue;
      }

      checkedFields.add(rule.field);
    }

    // finally check fields without any rules if they should fail the validation
    if (this.ruleSet.options.unexpectedFields === RuleType.FAIL) {
      const receivedFields = Object.keys(data);
      for (const field of receivedFields) {
        if (!checkedFields.has(field)) {
          violations.push({ field: field, message: `Unexpected field, got: ${field}` });
        }
      }
    }

    // if we have encountered a violation, throw an error
    if (violations.length > 0) {
      throw new ValidationError(violations);
    }
  }
}
