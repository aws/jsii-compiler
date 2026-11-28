import { compileJsiiForTest } from '../../../lib';

// The `.d.ts` side of --strip-deprecated: the paths the behavior tests do not reach.

test('an import of a stripped type re-exported under another name is removed', () => {
  const result = compileJsiiForTest(
    {
      'index.ts': `
        import { IRenamed } from './b';
        export * from './a';
        export interface IUse extends IRenamed {}
      `,
      'a.ts': `
        /** @deprecated gone */
        export interface IOld { m(): void; }
      `,
      'b.ts': `
        import { IOld } from './a';
        export { IOld as IRenamed };
      `,
    },
    undefined,
    { stripDeprecated: true },
  );
  expect(result.files['index.d.ts']).toMatchInlineSnapshot(`
    "import './b';
    import './a';
    export interface IUse {
    }
    "
  `);
});
