import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Assembly, loadAssemblyFromPath } from '@jsii/spec';

import { compile, Lock } from './fixtures';

let lock: Lock | undefined;

beforeAll(async () => {
  lock = await Lock.acquire();
}, 120_000);

afterAll(async () => {
  await lock?.release();
  lock = undefined;
}, 120_000);

// Note: Tests will run in this order, which is required for the v1
// compatibility test to succeed...

// @TODO(ts7): the fixtures used to be compiled with --add-deprecation-warnings, which the TypeScript 7 compiler
// does not implement yet; pass `true` again (and restore the HAS_DEPRECATION_WARNINGS matchers) with that port.
// The test keeps running without the flag: it also produces the dist/private tarballs the pacmak workflow job
// installs.
test('integration test', () => {
  const calcBaseOfBaseRoot = compile(lock!, '@scope/jsii-calc-base-of-base', false);
  const calcBaseRoot = compile(lock!, '@scope/jsii-calc-base', false);
  const calcLibRoot = compile(lock!, '@scope/jsii-calc-lib', false, 'deprecated-to-strip.txt');
  const calcRoot = compile(lock!, 'jsii-calc', false);

  expect(loadAssemblyFromPath(calcBaseOfBaseRoot)).toMatchSnapshot(
    { ...DEFAULT_MATCHER },
    '@scope/jsii-calc-base-of-base',
  );
  expect(loadAssemblyFromPath(calcBaseRoot)).toMatchSnapshot({ ...DEFAULT_MATCHER }, '@scope/jsii-calc-base');
  expect(loadAssemblyFromPath(calcLibRoot)).toMatchSnapshot({ ...DEFAULT_MATCHER }, '@scope/jsii-calc-lib');
  expect(loadAssemblyFromPath(calcRoot)).toMatchSnapshot({ ...DEFAULT_MATCHER }, 'jsii-calc');

  // Package up the tarballs for further integration/E2E testing...
  const distPrivate = join(__dirname, '..', 'dist', 'private');
  rmSync(distPrivate, { force: true, recursive: true });
  mkdirSync(distPrivate, { recursive: true });
  for (const dir of [calcBaseOfBaseRoot, calcBaseRoot, calcLibRoot, calcRoot]) {
    expect(spawnSync('npm', ['pack', `--pack-destination=${distPrivate}`, dir]).status).toBe(0);
  }
}, 120_000);

const DEFAULT_MATCHER: Partial<Assembly> = {
  fingerprint: expect.any(String),
  jsiiVersion: expect.any(String),
};
