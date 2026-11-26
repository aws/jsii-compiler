import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { findDependencyDirectory, findPackageJsonUp, findUp } from '../../src/common/find-utils';
import { JsiiError } from '../../src/utils';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsii-find-utils-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('findUp', () => {
  test('returns the starting directory if it matches', () => {
    expect(findUp(tmpDir, () => true)).toBe(tmpDir);
  });

  test('returns the closest ancestor that matches', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    writeFile(path.join(tmpDir, 'a', 'marker'), '');

    expect(findUp(nested, (dir) => fs.existsSync(path.join(dir, 'marker')))).toBe(path.join(tmpDir, 'a'));
  });

  test('returns undefined if nothing matches up to the filesystem root', () => {
    expect(findUp(tmpDir, () => false)).toBeUndefined();
  });
});

describe('findPackageJsonUp', () => {
  test('finds the directory with a package.json of the given name, skipping others', () => {
    writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'wanted-package' }));
    writeFile(path.join(tmpDir, 'sub', 'package.json'), JSON.stringify({ name: 'stray-package' }));
    const start = path.join(tmpDir, 'sub', 'lib');
    fs.mkdirSync(start, { recursive: true });

    expect(findPackageJsonUp('wanted-package', start)).toBe(tmpDir);
  });

  test('returns undefined if no package.json has that name', () => {
    writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'something-else' }));

    expect(findPackageJsonUp('jsii-test-no-such-package', tmpDir)).toBeUndefined();
  });
});

describe('findDependencyDirectory', () => {
  test('returns the directory of the dependency', () => {
    const depDir = path.join(tmpDir, 'node_modules', 'jsii-test-dep');
    writeFile(path.join(depDir, 'package.json'), JSON.stringify({ name: 'jsii-test-dep', main: 'index.js' }));
    writeFile(path.join(depDir, 'index.js'), 'module.exports = {};');

    expect(findDependencyDirectory('jsii-test-dep', tmpDir)).toBe(depDir);
  });

  test('throws if the resolved entry point is not inside a package.json with the dependency name', () => {
    // The package.json declares a different name, so it is not accepted as the dependency's manifest.
    const depDir = path.join(tmpDir, 'node_modules', 'jsii-test-mismatch');
    writeFile(path.join(depDir, 'package.json'), JSON.stringify({ name: 'not-the-same-name', main: 'index.js' }));
    writeFile(path.join(depDir, 'index.js'), 'module.exports = {};');

    expect(() => findDependencyDirectory('jsii-test-mismatch', tmpDir)).toThrow(JsiiError);
    expect(() => findDependencyDirectory('jsii-test-mismatch', tmpDir)).toThrow(
      `Could not find dependency 'jsii-test-mismatch' from '${tmpDir}'`,
    );
  });
});
