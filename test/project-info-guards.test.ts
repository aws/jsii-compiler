import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SPEC_FILE_NAME } from '@jsii/spec';

import { loadProjectInfo } from '../src/project-info';

// Lets a test make files "disappear" between two checks for their existence.
const hiddenAfterFirstCheck = new Set<string>();
const checked = new Set<string>();
jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return {
    ...actual,
    existsSync: (file: string) => {
      const exists = actual.existsSync(file);
      if (exists && hiddenAfterFirstCheck.has(file)) {
        if (checked.has(file)) {
          return false;
        }
        checked.add(file);
      }
      return exists;
    },
  };
});

describe('loadProjectInfo (local dependency whose assembly vanishes)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jsii-project-info-guards-'));
    fs.mkdirSync(path.join(projectRoot, 'local'));
    fs.writeFileSync(
      path.join(projectRoot, 'local', 'package.json'),
      JSON.stringify({ name: 'local-dependency', version: '1.0.0' }),
    );
    fs.writeFileSync(path.join(projectRoot, 'local', SPEC_FILE_NAME), '{}');
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        version: '1.0.0',
        license: 'Apache-2.0',
        author: 'Jane Doe',
        repository: 'aws/jsii-compiler',
        main: 'index.js',
        jsii: {},
        dependencies: { 'local-dependency': 'file:./local' },
        peerDependencies: { 'local-dependency': 'file:./local' },
      }),
    );
  });

  afterEach(() => {
    hiddenAfterFirstCheck.clear();
    checked.clear();
    fs.rmSync(projectRoot, { force: true, recursive: true });
  });

  test('is reported when the assembly file is gone right after it was located', () => {
    // The file is found by `findAssemblyFile`, but is no longer there when project-info checks again.
    hiddenAfterFirstCheck.add(path.join(projectRoot, 'local', SPEC_FILE_NAME));

    expect(() => loadProjectInfo(projectRoot)).toThrow(
      `Assembly does not exist: ${path.join(projectRoot, 'local', SPEC_FILE_NAME)}`,
    );
  });
});
