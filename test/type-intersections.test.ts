import * as spec from '@jsii/spec';

import { sourceToAssemblyHelper } from '../lib';
import { compileJsiiForErrors } from './compiler-helpers';

const IFOO_IBAR = `
  export interface IFoo { readonly foo: string; }
  export interface IBar { readonly bar: string; }
`;

// ----------------------------------------------------------------------

describe('positive tests', () => {
  test.each([false, true])('intersection type as a function parameter (optional=%p)', (optional) => {
    const q = optional ? '?' : '';

    const assembly = sourceToAssemblyHelper(`
      ${IFOO_IBAR}
      export class Api {
        public static fooAndBar(x${q}: IFoo & IBar) {
          return (x?.foo ?? '') + (x?.bar ?? '');
        }
      }
    `);

    expect((assembly.types!['testpkg.Api'] as spec.ClassType).methods?.[0]).toMatchObject({
      name: 'fooAndBar',
      parameters: [
        {
          name: 'x',
          ...(optional ? { optional: true } : undefined),
          type: {
            intersection: {
              types: [{ fqn: 'testpkg.IFoo' }, { fqn: 'testpkg.IBar' }],
            },
          },
        },
      ],
    });
  });

  test.each([false, true])('intersection type as a struct member (optional=%p)', (optional) => {
    const q = optional ? '?' : '';

    const assembly = sourceToAssemblyHelper(`
      ${IFOO_IBAR}
      export interface InputProps {
        readonly x${q}: IFoo & IBar;
      }

      export class Api {
        public static fooAndBar(props: InputProps) {
          return (props.x?.foo ?? '') + (props.x?.bar ?? '');
        }
      }
    `);

    expect((assembly.types!['testpkg.InputProps'] as spec.InterfaceType).properties?.[0]).toMatchObject({
      name: 'x',
      ...(optional ? { optional: true } : undefined),
      type: {
        intersection: {
          types: [{ fqn: 'testpkg.IFoo' }, { fqn: 'testpkg.IBar' }],
        },
      },
    });
  });

  test('intersection type as an array element type', () => {
    const assembly = sourceToAssemblyHelper(`
      ${IFOO_IBAR}
      export class Api {
        public static fooAndBar(xs: (IFoo & IBar)[]) {
          return String(xs);
        }
      }
    `);

    expect((assembly.types!['testpkg.Api'] as spec.ClassType).methods?.[0]).toMatchObject({
      name: 'fooAndBar',
      parameters: [
        {
          name: 'xs',
          type: {
            collection: {
              kind: 'array',
              elementtype: {
                intersection: {
                  types: [{ fqn: 'testpkg.IFoo' }, { fqn: 'testpkg.IBar' }],
                },
              },
            },
          },
        },
      ],
    });
  });

  test('intersection type as a map element type', () => {
    const assembly = sourceToAssemblyHelper(`
      ${IFOO_IBAR}
      export class Api {
        public static fooAndBar(xs: Record<string, IFoo & IBar>) {
          return String(xs);
        }
      }
    `);

    expect((assembly.types!['testpkg.Api'] as spec.ClassType).methods?.[0]).toMatchObject({
      name: 'fooAndBar',
      parameters: [
        {
          name: 'xs',
          type: {
            collection: {
              kind: 'map',
              elementtype: {
                intersection: {
                  types: [{ fqn: 'testpkg.IFoo' }, { fqn: 'testpkg.IBar' }],
                },
              },
            },
          },
        },
      ],
    });
  });

  test('the use of intersection types is reflected in a usedFeature', () => {
    // WHEN
    const assembly = sourceToAssemblyHelper(`
      ${IFOO_IBAR}
      export class Api {
        public static fooAndBar(x: IFoo & IBar) {
          return (x?.foo ?? '') + (x?.bar ?? '');
        }
      }
    `);

    // THEN
    expect(assembly.usedFeatures).toContain('intersection-types');
  });
});

describe('intersection type may not be used in output position', () => {
  function expectIntersectionTypeError(code: string) {
    const errs = compileJsiiForErrors(code);
    expect(errs).toContainEqual(expect.stringContaining('Intersection types may only be used as inputs'));
  }

  test('direct return', () => {
    expectIntersectionTypeError(`
      ${IFOO_IBAR}
      export class Api {
        public static fooAndBar(): IFoo & IBar {
          return { foo: 'foo', bar: 'bar' };
        }
      }
    `);
  });

  test('part of return struct', () => {
    expectIntersectionTypeError(`
      ${IFOO_IBAR}
      export interface OutputProps {
        readonly x: IFoo & IBar;
      }

      export class Api {
        public static fooAndBar(): OutputProps {
          return { x: { foo: 'foo', bar: 'bar' } };
        }
      }
    `);
  });

  test('part of both input and output struct', () => {
    expectIntersectionTypeError(`
      ${IFOO_IBAR}
      export interface OutputProps {
        readonly x: IFoo & IBar;
      }

      export class Api {
        public static fooAndBar(props: OutputProps): OutputProps {
          return props;
        }
      }
    `);
  });

  test('transitively part of return struct', () => {
    expectIntersectionTypeError(`
      ${IFOO_IBAR}
      export interface NestedObject { readonly x: IFoo & IBar }
      export interface OutputProps { readonly nested: NestedObject }
      export class Api {
        public static fooAndBar(): OutputProps {
          return { nested: { x: { foo: 'foo', bar: 'bar' } } };
        }
      }
    `);
  });

  test.each([
    ['', ''],
    ['readonly', ''],
    ['', '?'],
    ['readonly', '?'],
  ])('readable member of interface %p %p', (ro, q) => {
    expectIntersectionTypeError(`
      ${IFOO_IBAR}
      export interface IObject {
        ${ro} member${q}: IFoo & IBar;
      }
    `);
  });

  test.each([
    ['', ''],
    ['readonly', ''],
    ['', '?'],
    ['readonly', '?'],
  ])('readable member of class %p %p', (ro, q) => {
    expectIntersectionTypeError(`
      ${IFOO_IBAR}
      export class Obj {
        ${ro} member${q}: IFoo & IBar;

        constructor() {
          this.member = { foo: 'foo', bar: 'bar' };
        }
      }
    `);
  });
});

test.each([
  ['IFoo', 'string', 'Found non-interface type in type intersection: string'],
  ['boolean', 'string', '"never" type is not allowed'],
  ['IFoo[]', 'IBar', 'Found non-interface type in type intersection: array'],
  ['IBar', 'SomeClass', 'Found non-interface type in type intersection: testpkg.SomeClass'],
])('intersection type may not combine %s and %s', (lhs, rhs, errorMessage) => {
  const errs = compileJsiiForErrors(
    `
    ${IFOO_IBAR}
    export class SomeClass { }
    Array.isArray(SomeClass);

    export class Api {
      public static fooAndBar(x: ${lhs} & ${rhs}) {
        return String(x);
      }
    }
  `,
  );

  expect(errs).toContainEqual(expect.stringContaining(errorMessage));
});

test('intersection types may not be used as constructor args', () => {
  const errs = compileJsiiForErrors(
    `
    ${IFOO_IBAR}
    export class Api {
      public constructor(x: IFoo & IBar) {
        Array.isArray(x);
      }
    }
  `,
  );

  expect(errs).toContainEqual(expect.stringContaining('Intersection types cannot be used as constructor arguments'));
});

test.each([
  ['readonly bar: string', 'readonly bar: string', true as const],
  ['readonly bar: string', 'bar: string', true as const], // read-only & read-write is okay
  ['readonly bar?: string', 'readonly bar: string', 'Member bar is different'],
  ['bar(): string', 'bar(): string', true as const],
  ['bar(): string', 'bar(): string | undefined', 'Member bar is different'],
])('intersection of %p and %p => %p', (left, right, error: string | true) => {
  const errs = compileJsiiForErrors(
    `
        export interface IFoo {
          ${left};
        }

        export interface IBar {
          ${right};
        }

        export class Api {
          public use(x: IFoo & IBar) {
            Array.isArray(x);
          }
        }
      `,
  );

  if (error === true) {
    expect(errs).toEqual([]);
  } else {
    expect(errs).toContainEqual(expect.stringContaining(error));
  }
});
