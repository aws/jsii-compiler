import { Assembly, loadAssemblyFromPath } from '@jsii/spec';
import { compile, Lock } from './fixtures';

let lock: Lock | undefined;

beforeEach(async () => {
  lock = await Lock.acquire();
}, 120_000);

afterEach(async () => {
  await lock?.release();
  lock = undefined;
}, 120_000);

test('integration', async () => {
  const calcBaseOfBaseRoot = compile(lock!, '@scope/jsii-calc-base-of-base', false);
  const calcBaseRoot = compile(lock!, '@scope/jsii-calc-base', true);
  const calcLibRoot = compile(lock!, '@scope/jsii-calc-lib', true, 'deprecated-to-strip.txt');
  const calcRoot = compile(lock!, 'jsii-calc', true);

  expect(loadAssemblyFromPath(calcBaseOfBaseRoot)).toMatchSnapshot(
    { ...DEFAULT_MATCHER },
    '@scope/jsii-calc-base-of-base',
  );
  expect(loadAssemblyFromPath(calcBaseRoot)).toMatchSnapshot(
    { ...DEFAULT_MATCHER, ...HAS_DEPRECATION_WARNINGS },
    '@scope/jsii-calc-base',
  );
  expect(loadAssemblyFromPath(calcLibRoot)).toMatchSnapshot(
    { ...DEFAULT_MATCHER, ...HAS_DEPRECATION_WARNINGS },
    '@scope/jsii-calc-lib',
  );
  expect(loadAssemblyFromPath(calcRoot)).toMatchSnapshot(
    { ...DEFAULT_MATCHER, ...HAS_DEPRECATION_WARNINGS },
    'jsii-calc',
  );
}, 120_000);

const DEFAULT_MATCHER: Partial<Assembly> = {
  fingerprint: expect.any(String),
  jsiiVersion: expect.any(String),
};
const HAS_DEPRECATION_WARNINGS: Partial<Assembly> = {
  metadata: {
    jsii: {
      compiledWithDeprecationWarnings: true,
    },
  },
};
