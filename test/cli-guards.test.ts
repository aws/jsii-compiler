import * as fs from 'node:fs';

import { makeCliProject, mockYargsToTrackParse, runCli } from './cli-helpers';

// yargs rejects `--tsconfig` together with `--generate-tsconfig` before the command handler runs. The handler checks
// it again, so these tests remove yargs' own check to exercise the handler's.
jest.mock('yargs', () => mockYargsToTrackParse({ ignoreConflicts: true }));

// A failure that is not a `JsiiError` while validating a tsconfig is not handled by the command.
jest.mock('../src/tsconfig/tsconfig-validator', () => {
  const actual = jest.requireActual('../src/tsconfig/tsconfig-validator');
  return {
    ...actual,
    validateTypeScriptConfigFile: jest.fn(() => {
      throw new Error('unexpected validation failure');
    }),
  };
});

let project: string;

beforeEach(() => {
  project = makeCliProject();
});

afterEach(() => {
  fs.rmSync(project, { force: true, recursive: true });
});

describe('jsii compile', () => {
  test('rejects --tsconfig together with --generate-tsconfig, and shows the help', async () => {
    const result = await runCli(project, '--tsconfig', 'a.json', '--generate-tsconfig', 'b.json');

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('Options --generate-tsconfig and --tsconfig are mutually exclusive');
    expect(result.stderr).toContain('jsii compile [PROJECT_ROOT]');
  });
});

describe('jsii validate-tsconfig', () => {
  test('does not handle errors that are not JsiiErrors', async () => {
    fs.writeFileSync(`${project}/tsconfig.json`, '{}');

    const result = await runCli(project, 'validate-tsconfig');

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('Error: unexpected validation failure');
  });
});
