import * as spec from '@jsii/spec';
import { Stability } from '@jsii/spec';

import { compileJsiiForTest, sourceToAssemblyHelper as compile } from '../lib';

jest.setTimeout(60_000);

// ----------------------------------------------------------------------
test('extract summary line from doc block, ends with a period', () => {
  const assembly = compile(`
    /**
     * Hello this is the documentation for this class
     */
    export class Foo {
      public bar() { }
    }
  `);

  expect(assembly.types!['testpkg.Foo'].docs).toEqual({
    summary: 'Hello this is the documentation for this class.',
  });
});

// ----------------------------------------------------------------------
test('extract remarks from whitespace-separated doc block', () => {
  const assembly = compile(`
    /**
     * Hello this is the documentation for this class.
     *
     * Here are some more details about it.
     *
     * It looks pretty good, doesn't it?
     */
    export class Foo {
      public bar() { }
    }
  `);

  expect(assembly.types!['testpkg.Foo'].docs!.remarks).toBe(
    "Here are some more details about it.\n\nIt looks pretty good, doesn't it?",
  );
});

// ----------------------------------------------------------------------
test('separate long doc comment into summary and remarks', () => {
  const assembly = compile(`
    /**
     * Lots of people enjoy writing very long captions here. I think it's because they
     * copy/paste them out of CloudFormation, which has a tendency to just have one
     * doc block per API item and no structural separation.
     */
    export class Foo {
      public bar() { }
    }
  `);

  expect(assembly.types!['testpkg.Foo'].docs).toEqual({
    summary: 'Lots of people enjoy writing very long captions here.',
    remarks:
      "I think it's because they\ncopy/paste them out of CloudFormation, which has a tendency to just have one\n" +
      'doc block per API item and no structural separation.',
  });
});

// ----------------------------------------------------------------------
test('separate non-space but newline terminated docs into summary&remarks', () => {
  const assembly = compile(`
    /**
     * Lots of people enjoy writing very long captions here.
     * I think it's because they copy/paste them out of CloudFormation,
     * which has a tendency to just have one
     * doc block per API item and no structural separation.
     */
    export class Foo {
      public bar() { }
    }
  `);

  expect(assembly.types!['testpkg.Foo'].docs).toEqual({
    summary: 'Lots of people enjoy writing very long captions here.',
    remarks:
      "I think it's because they copy/paste them out of CloudFormation,\nwhich has a tendency to just have one\n" +
      'doc block per API item and no structural separation.',
  });
});

// ----------------------------------------------------------------------
test('dont add period to summary that ends in exclamation mark', () => {
  const assembly = compile(`
    /**
     * I'm happy about this class!
     */
    export class Foo {
      public bar() { }
    }
  `);

  expect(assembly.types!['testpkg.Foo'].docs).toEqual({
    summary: "I'm happy about this class!",
  });
});

// ----------------------------------------------------------------------
test('parse method docs', () => {
  const assembly = compile(`
    export class Foo {
      /**
       * Do the foo
       */
      public bar(arg: string) { Array.isArray(arg); }
    }
  `);

  const classType = assembly.types!['testpkg.Foo'] as spec.ClassType;

  expect(classType.methods![0].docs).toEqual({
    summary: 'Do the foo.',
  });
});

// ----------------------------------------------------------------------
test('associate parameter comments with right parameter', () => {
  const assembly = compile(`
    export class Foo {
      /**
       * Do the foo
       *
       * @param arg First argument is best argument
       */
      public bar(arg: string) { Array.isArray(arg); }
    }
  `);

  const classType = assembly.types!['testpkg.Foo'] as spec.ClassType;

  expect(classType.methods![0].parameters![0].docs).toEqual({
    summary: 'First argument is best argument.',
  });
});

// ----------------------------------------------------------------------
test('read example', () => {
  const assembly = compile(`
    export class Foo {
      /**
       * Do the foo
       *
       * @example
       *
       * // Example of fooing it up:
       * new Foo().bar();
       */
      public bar() {}
    }
  `);

  const classType = assembly.types!['testpkg.Foo'] as spec.ClassType;

  expect(classType.methods![0].docs!.example).toBe('// Example of fooing it up:\n' + 'new Foo().bar();');
});

// ----------------------------------------------------------------------
test('read default value', () => {
  const assembly = compile(`
    export interface Foo {
      /**
       * The foo we're talking about
       *
       * @default Some foo
       */
      readonly foo?: string;
    }
  `);

  const classType = assembly.types!['testpkg.Foo'] as spec.InterfaceType;

  expect(classType.properties![0].docs!.default).toBe('Some foo');
});

// ----------------------------------------------------------------------
test('read "see" annotation', () => {
  const assembly = compile(`
    /**
     * @see http://lmgtfy.com/
     */
    export class Foo {
    }
  `);

  expect(assembly.types!['testpkg.Foo'].docs!.see).toBe('http://lmgtfy.com/');
});

// ----------------------------------------------------------------------
test('read "returns" annotation', () => {
  const assembly = compile(`
    export class Foo {
      /**
       * Do the foo
       *
       * @returns Nothing, why would it?
       */
      public bar(arg: string) { Array.isArray(arg); }
    }
  `);

  const classType = assembly.types!['testpkg.Foo'] as spec.ClassType;

  expect(classType.methods![0].docs!.returns).toBe('Nothing, why would it?');
});

// ----------------------------------------------------------------------
test('can haz deprecated', () => {
  const assembly = compile(`
    export class Foo {
      /**
       * Do the foo
       *
       * @deprecated These days we do the bar
       */
      public bar(arg: string) { Array.isArray(arg); }
    }
  `);

  const classType = assembly.types!['testpkg.Foo'] as spec.ClassType;

  expect(classType.methods![0].docs!.deprecated).toBe('These days we do the bar');
});

// ----------------------------------------------------------------------
test('can mark stable', () => {
  const assembly = compile(`
    /**
     * Rock solid Foo
     *
     * @stable
     */
    export class Foo {
    }
  `);

  const classType = assembly.types!['testpkg.Foo'] as spec.ClassType;

  expect(classType.docs!.stability).toBe(spec.Stability.Stable);
});

// ----------------------------------------------------------------------
test('can mark experimental', () => {
  const assembly = compile(`
    /**
     * Slightly less solid Foo
     *
     * @experimental
     */
    export class Foo {
    }
  `);

  const classType = assembly.types!['testpkg.Foo'] as spec.ClassType;

  expect(classType.docs!.stability).toBe(spec.Stability.Experimental);
});

// ----------------------------------------------------------------------

test('can mark external', () => {
  const assembly = compile(`
    /**
     * @stability external
     */
    export class Foo {
      public floop() {
        Array.isArray(3);
      }
    }
  `);

  const classType = assembly.types!['testpkg.Foo'] as spec.ClassType;
  const method = classType.methods!.find((m) => m.name === 'floop');

  expect(classType.docs!.stability).toBe(spec.Stability.External);
  expect(method!.docs!.stability).toBe(spec.Stability.External);
});

// ----------------------------------------------------------------------
test('can mark subclassable', () => {
  const assembly = compile(`
    /**
     * Become this Foo
     *
     * @subclassable
     */
    export class Foo {
    }
  `);

  const classType = assembly.types!['testpkg.Foo'] as spec.ClassType;

  expect(classType.docs!.subclassable).toBeTruthy();
});

// ----------------------------------------------------------------------
test('can add arbitrary tags', () => {
  const assembly = compile(`
    /**
     * @boop
     */
    export class Foo {
    }
  `);

  const classType = assembly.types!['testpkg.Foo'] as spec.ClassType;

  expect(classType.docs!.custom).toEqual({ boop: 'true' });
});

// ----------------------------------------------------------------------
test('stability is inherited from parent type', () => {
  const stabilities = [
    ['@deprecated Not good no more', Stability.Deprecated],
    ['@experimental', Stability.Experimental],
    ['@stable', Stability.Stable],
  ];

  for (const [tag, stability] of stabilities) {
    // eslint-disable-next-line no-await-in-loop
    const assembly = compile(`
      /**
       * ${tag}
       */
      export class Foo {
        constructor() {
          Array.isArray(3);
        }

        public bar() {
          Array.isArray(3);
        }
      }
    `);
    /* eslint-enable no-await-in-loop */

    const classType = assembly.types!['testpkg.Foo'] as spec.ClassType;
    const initializer = classType.initializer!;
    const method = classType.methods!.find((m) => m.name === 'bar')!;

    expect(classType.docs!.stability).toBe(stability);
    expect(initializer.docs!.stability).toBe(stability);
    expect(method.docs!.stability).toBe(stability);
  }
});

// ----------------------------------------------------------------------
test('@example can contain @ sign', () => {
  const assembly = compile(`
    /**
     * An IAM role to associate with the instance profile assigned to this Auto Scaling Group.
     *
     * @example
     *
     * import * as x from '@banana';
     */
    export class Foo {
    }
  `);

  const classType = assembly.types!['testpkg.Foo'] as spec.ClassType;
  expect(classType.docs!.example).toBe("import * as x from '@banana';");
});

// ----------------------------------------------------------------------
test('preserves {@link} labels that span multiple JSDoc lines', () => {
  const assembly = compile(`
    /**
     * Matches the content of a variable that comes from a state. See {@link https://case.contract-testing.io/docs/defining-contracts/state-definitions | state
     * definitions}
     * and {@link https://case.contract-testing.io/docs/reference/state-handlers | state handlers} for
     * more details.
     *
     * Also see {@link https://example.com/one-line | a one-line label}.
     * Compact: {@link https://x.dev|label}.
     * Compact multiline: {@link https://x.dev|label across
     * lines}.
     */
    export class Foo {
    }
  `);

  const docs = assembly.types!['testpkg.Foo'].docs!;
  const text = [docs.summary, docs.remarks].filter(Boolean).join('\n');

  expect(text).toContain(
    '{@link https://case.contract-testing.io/docs/defining-contracts/state-definitions | state definitions}',
  );
  expect(text).toContain('{@link https://case.contract-testing.io/docs/reference/state-handlers | state handlers}');
  expect(text).toContain('{@link https://example.com/one-line | a one-line label}');
  expect(text).toContain('{@link https://x.dev | label}.');
  expect(text).toContain('{@link https://x.dev | label across lines}');
  expect(text).not.toContain('https://x.dev|');

  expect(text.match(/state definitions/g)).toEqual(['state definitions']);
  expect(text).not.toMatch(/\*\s*definitions/);
});

// ----------------------------------------------------------------------
test('preserves multiline {@link} labels on methods and properties', () => {
  const assembly = compile(`
    export class Foo {
      /**
       * See {@link https://example.com/method | method
       * label} for details.
       */
      public bar() {}

      /**
       * See {@link https://example.com/property | property
       * label} for details.
       */
      public readonly baz: string = 'x';
    }
  `);

  const classType = assembly.types!['testpkg.Foo'] as spec.ClassType;
  const methodText = [classType.methods![0].docs?.summary, classType.methods![0].docs?.remarks]
    .filter(Boolean)
    .join('\n');
  const propertyText = [classType.properties![0].docs?.summary, classType.properties![0].docs?.remarks]
    .filter(Boolean)
    .join('\n');

  expect(methodText).toContain('{@link https://example.com/method | method label}');
  expect(methodText).not.toMatch(/\*\s*label/);
  expect(propertyText).toContain('{@link https://example.com/property | property label}');
  expect(propertyText).not.toMatch(/\*\s*label/);
});

// ----------------------------------------------------------------------
test('does not rewrite an earlier intact {@link} when a later label closes on its own line', () => {
  const assembly = compile(`
    /**
     * First {@link Bar | b} then {@link Baz | x
} end.
     */
    export class Foo {
    }
  `);

  const docs = assembly.types!['testpkg.Foo'].docs!;
  const text = [docs.summary, docs.remarks].filter(Boolean).join('\n');

  expect(text).toContain('{@link Bar | b}');
  expect(text).toContain('{@link Baz | x}');
  expect(text).not.toContain('{@link Baz | x }');
  expect(text).not.toContain('{@link Baz | x}}');
});

// ----------------------------------------------------------------------
test('renders {@link} labels as {@link target | label}', () => {
  const assembly = compile(`
    export class Foo {}
    /**
     * Resolved pipe {@link Foo | b}.
     * Resolved space {@link Foo some text}.
     * Unresolved pipe {@link Bar | b}.
     * Unresolved space {@link Bar some text}.
     * URL pipe {@link https://x.dev|label}.
     * URL space {@link https://x.dev label with spaces}.
     * Unlabeled resolved {@link Foo}.
     * Unlabeled unresolved {@link Bar}.
     * Unlabeled URL {@link https://x.dev}.
     */
    export class Probe {}
  `);

  const docs = assembly.types!['testpkg.Probe'].docs!;
  const text = [docs.summary, docs.remarks].filter(Boolean).join('\n');

  expect(text).toContain('Resolved pipe {@link Foo | b}.');
  expect(text).toContain('Resolved space {@link Foo | some text}.');
  expect(text).toContain('Unresolved pipe {@link Bar | b}.');
  expect(text).toContain('Unresolved space {@link Bar | some text}.');
  expect(text).toContain('URL pipe {@link https://x.dev | label}.');
  expect(text).toContain('URL space {@link https://x.dev | label with spaces}.');
  expect(text).toContain('Unlabeled resolved {@link Foo}.');
  // TypeScript renders an unlabeled unresolved name as `{@link Bar }` (trailing space).
  expect(text).toContain('Unlabeled unresolved {@link Bar }.');
  expect(text).not.toContain('Unlabeled unresolved {@link Bar |');
  expect(text).toContain('Unlabeled URL {@link https://x.dev}.');
  expect(text).not.toContain('{@link Foob}');
  expect(text).not.toContain('{@link Foosome text}');
});

// ----------------------------------------------------------------------
test('renders {@link} labels in @deprecated and @see as {@link target | label}', () => {
  const assembly = compile(`
    export class Foo {}
    /**
     * @deprecated use {@link Foo | the replacement} instead
     * @see {@link https://x.dev | see label}
     */
    export class Probe {}
  `);

  const docs = assembly.types!['testpkg.Probe'].docs!;
  expect(docs.deprecated).toBe('use {@link Foo | the replacement} instead');
  expect(docs.see).toBe('{@link https://x.dev | see label}');
});

// ----------------------------------------------------------------------
// @TODO(ts7): TypeScript 7 renders a {@link} that is never closed differently ("See label ..."); match main
test.skip('keeps the label of a {@link} that is never closed', () => {
  const assembly = compile(`
    /**
     * See {@link Foo | label
     * which continues without closing.
     */
    export class Foo {
    }
  `);

  // TypeScript closes the link at the line break, the remaining text is left as is
  expect(assembly.types!['testpkg.Foo'].docs!.summary).toMatch(
    /^See \{@link Foo \| label\}\s+\* which continues without closing\.$/,
  );
});

// ----------------------------------------------------------------------
// @TODO(ts7): the {@link} in the @param docs of a parameter property is not rendered like main yet
test.skip('renders {@link} in docs of a property declared through a constructor parameter', () => {
  const assembly = compile(`
    export class Foo {
      /**
       * Creates a Foo.
       *
       * @param value the {@link Foo | value} to wrap
       */
      public constructor(public readonly value: string) {}
    }
  `);

  const classType = assembly.types!['testpkg.Foo'] as spec.ClassType;
  expect(classType.properties!.find((p) => p.name === 'value')!.docs).toEqual({
    summary: 'the {@link Foo | value} to wrap.',
  });
});

// ----------------------------------------------------------------------
describe('@stability', () => {
  test.each([
    ['stable', Stability.Stable],
    ['experimental', Stability.Experimental],
    ['external', Stability.External],
    ['deprecated', Stability.Deprecated],
  ])('@stability %s', (value, expected) => {
    const assembly = compile(`
      /**
       * @stability ${value}
       */
      export class Foo {
      }
    `);

    expect(assembly.types!['testpkg.Foo'].docs!.stability).toBe(expected);
  });

  test('@deprecated can be combined with @stability deprecated', () => {
    const assembly = compile(`
      /**
       * @stability deprecated
       * @deprecated Use something else
       */
      export class Foo {
      }
    `);

    expect(assembly.types!['testpkg.Foo'].docs).toEqual({
      stability: Stability.Deprecated,
      deprecated: 'Use something else',
    });
  });
});

// ----------------------------------------------------------------------
describe('documentation errors (JSII7999)', () => {
  function documentationErrors(source: string): string[] {
    const { diagnostics } = compileJsiiForTest(source, { captureDiagnostics: true });
    return diagnostics.filter((d) => (d as { jsiiCode?: number }).jsiiCode === 7999).map((d) => `${d.messageText}`);
  }

  test('unrecognized @stability value', () => {
    expect(
      documentationErrors(`
        /** @stability banana */
        export class Foo {}
      `),
    ).toEqual(["Unrecognized @stability: 'banana'"]);
  });

  test.each([
    ['@stability stable', '@experimental'],
    ['@stability experimental', '@stable'],
    ['@experimental', '@stable'],
  ])('%s combined with %s', (first, second) => {
    expect(
      documentationErrors(`
        /**
         * ${first}
         * ${second}
         */
        export class Foo {}
      `),
    ).toEqual(['Use only one of @stability, @experimental or @stable']);
  });

  test('@deprecated combined with another @stability', () => {
    expect(
      documentationErrors(`
        /**
         * @stability stable
         * @deprecated Use something else
         */
        export class Foo {}
      `),
    ).toEqual(["@deprecated tag requires '@stability deprecated' or no @stability at all."]);
  });

  test('@deprecated without a reason', () => {
    expect(
      documentationErrors(`
        /** @deprecated */
        export class Foo {}
      `),
    ).toEqual(['@deprecated tag needs a reason and/or suggested alternatives.']);
  });

  test('@example with code block fences', () => {
    expect(
      documentationErrors(`
        /**
         * @example
         * \`\`\`ts
         * new Foo();
         * \`\`\`
         */
        export class Foo {}
      `),
    ).toEqual(['@example must be code only, no code block fences allowed.']);
  });

  test('valid documentation does not produce errors', () => {
    expect(
      documentationErrors(`
        /**
         * Hello.
         *
         * @stability experimental
         * @example new Foo();
         */
        export class Foo {}
      `),
    ).toEqual([]);
  });
});

// ----------------------------------------------------------------------
describe('@example followed by an unrecognized tag', () => {
  // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2950
  // The unrecognized tag is absorbed back into the example, but its text is rendered as "[object Object]"
  // and the code that follows it is lost.
  // @TODO(ts7): the TypeScript 7 compiler drops the text of an unrecognized tag after @example
  test.skip('renders the tag text as "[object Object]"', () => {
    const assembly = compile(`
      /**
       * Summary.
       *
       * @example
       * const x = 1;
       * @decorator
       * class Foo {}
       */
      export class Foo {
      }
    `);

    expect(assembly.types!['testpkg.Foo'].docs!.example).toBe('const x = 1;@decorator[object Object]');
  });

  test('a recognized tag after the example ends the example', () => {
    const assembly = compile(`
      /**
       * Summary.
       *
       * @example
       * const x = 1;
       * @stable
       */
      export class Foo {
      }
    `);

    const docs = assembly.types!['testpkg.Foo'].docs!;
    expect(docs.example).toBe('const x = 1;');
    expect(docs.stability).toBe(Stability.Stable);
  });
});
