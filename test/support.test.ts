import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';

import { makeCliProject, mockYargsToTrackParse, runCli, runCliWithEnv } from './cli-helpers';

jest.mock('yargs', () => mockYargsToTrackParse());

// The CLI checks the support policy of the compiler by downloading a document from GitHub. The network is the only
// thing replaced here: the fake answers like GitHub would, and everything else is the real CLI.
// (The factory is evaluated for each isolated copy of the CLI, so it hands over to a function that is set per test.)
jest.mock('node:https', () => ({ get: (...args: unknown[]) => (globalThis as any).__fakeHttpsGet(...args) }));

const RELEASES_URL = 'https://raw.githubusercontent.com/aws/jsii-compiler/main/releases.json';

type FakeResponse =
  | {
      readonly statusCode: number;
      readonly statusMessage?: string;
      readonly body?: string;
      /** Emitted on the response instead of delivering the body. */
      readonly error?: Error;
    }
  | { readonly requestEvent: 'abort' | 'timeout' | 'error'; readonly error?: Error };

/** Makes the "download" answer with `respond`. */
function fakeReleasesServer(respond: FakeResponse) {
  (globalThis as any).__fakeHttpsGet = (url: URL, callback: (response: EventEmitter) => void) => {
    if (url.toString() !== RELEASES_URL) {
      throw new Error(`Unexpected request to ${url}`);
    }
    const request = Object.assign(new EventEmitter(), {
      end: () => {
        setImmediate(() => {
          if ('requestEvent' in respond) {
            request.emit(respond.requestEvent, respond.error);
            return;
          }
          const response = Object.assign(new EventEmitter(), {
            statusCode: respond.statusCode,
            statusMessage: respond.statusMessage,
          });
          callback(response);
          if (respond.error) {
            response.emit('error', respond.error);
          } else if (respond.statusCode === 200) {
            response.emit('data', Buffer.from(respond.body ?? ''));
            response.emit('end');
          }
        });
      },
    });
    return request;
  };
}

let projectDir: string;
let releaseLine: string;

beforeAll(async () => {
  // The release line of the compiler is the major and minor version of the TypeScript it embeds.
  const versionProject = makeCliProject();
  try {
    const { stdout } = await runCli(versionProject, '--version');
    releaseLine = /typescript (\d+\.\d+)\./.exec(stdout)![1];
  } finally {
    fs.rmSync(versionProject, { force: true, recursive: true });
  }
});

beforeEach(() => {
  projectDir = makeCliProject();
  // Only the date is faked: the CLI waits with timers.
  jest.useFakeTimers({
    now: new Date('2026-06-15T12:00:00.000Z'),
    doNotFake: [
      'nextTick',
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'queueMicrotask',
      'performance',
      'hrtime',
    ],
  });
});

afterEach(() => {
  jest.useRealTimers();
  fs.rmSync(projectDir, { force: true, recursive: true });
});

/** Builds a releases document in which the compiler's own release line is in the given state. */
function releases(options: { endOfSupport?: boolean; supportedUntil?: string; current?: string }) {
  const maintenance: Record<string, string> = {
    // Release lines that are always far enough in the future to be offered as alternatives.
    '98.0': '2999-01-01T00:00:00.000Z',
    '98.1': '2999-06-30T00:00:00.000Z',
    // A release line that is too close to End-of-Support to be offered as an alternative.
    '97.0': '2026-01-15T00:00:00.000Z',
  };
  if (options.supportedUntil) {
    maintenance[releaseLine] = options.supportedUntil;
  }
  return JSON.stringify({
    current: options.current ?? '99.0',
    maintenance,
    ...(options.endOfSupport ? { endOfSupport: [releaseLine] } : {}),
  });
}

/** Runs the CLI with the support policy check enabled, and returns what it printed to standard error without colors. */
async function supportNotice(env: Record<string, string | undefined> = {}) {
  const result = await runCliWithEnv({ JSII_SILENCE_SUPPORT_WARNING: undefined, ...env }, projectDir, '--version');
  return result.stderr.replace(/\u001b\[[\d;]*m/g, '');
}

describe('the support policy notice', () => {
  test('is not shown when silenced', async () => {
    fakeReleasesServer({ statusCode: 200, body: releases({ endOfSupport: true }) });

    expect(await supportNotice({ JSII_SILENCE_SUPPORT_WARNING: '1' })).not.toContain('release line');
  });

  test('is not shown when the compiler is on the current release line', async () => {
    fakeReleasesServer({ statusCode: 200, body: releases({ current: releaseLine }) });

    expect(await supportNotice()).not.toContain('release line');
  });

  test('is not shown when the status of the release line is unknown', async () => {
    fakeReleasesServer({ statusCode: 200, body: releases({}) });

    expect(await supportNotice()).not.toContain('release line');
  });

  test('is not shown when End-of-Support is more than 30 days away', async () => {
    fakeReleasesServer({ statusCode: 200, body: releases({ supportedUntil: '2026-08-01T00:00:00.000Z' }) });

    expect(await supportNotice()).not.toContain('release line');
  });

  test('warns when End-of-Support is less than 30 days away', async () => {
    fakeReleasesServer({ statusCode: 200, body: releases({ supportedUntil: '2026-07-01T00:00:00.000Z' }) });

    const notice = await supportNotice();

    expect(notice).toContain(`The ${releaseLine} release line of jsii will reach End-of-Support soon, on 2026-07-01.`);
    expect(notice).toContain('upgrade to the current release line (99.0)');
    expect(notice).toContain('Other actively supported release lines include:');
    expect(notice).toContain('- 98.0 (planned End-of-Support date: 2999-01-01)');
    expect(notice).toContain('- 98.1 (planned End-of-Support date: 2999-06-30)');
    expect(notice).not.toContain('97.0');
  });

  test('warns when End-of-Support has passed', async () => {
    fakeReleasesServer({ statusCode: 200, body: releases({ supportedUntil: '2026-06-01T00:00:00.000Z' }) });

    const notice = await supportNotice();

    expect(notice).toContain(`The ${releaseLine} release line of jsii has reached End-of-Support.`);
    expect(notice).toContain('upgrade to the current release line (99.0)');
  });

  test('warns when the release line is listed as end-of-support', async () => {
    fakeReleasesServer({ statusCode: 200, body: releases({ endOfSupport: true }) });

    expect(await supportNotice()).toContain(`The ${releaseLine} release line of jsii has reached End-of-Support.`);
  });

  test('does not list alternatives when no other release line is supported long enough', async () => {
    fakeReleasesServer({
      statusCode: 200,
      body: JSON.stringify({ current: '99.0', maintenance: {}, endOfSupport: [releaseLine] }),
    });

    const notice = await supportNotice();

    expect(notice).toContain('has reached End-of-Support');
    expect(notice).not.toContain('Other actively supported release lines include:');
  });

  test('is surrounded with a border', async () => {
    fakeReleasesServer({ statusCode: 200, body: releases({ endOfSupport: true }) });

    const lines = (await supportNotice()).trimEnd().split('\n');

    expect(lines[0]).toMatch(/^!+$/);
    expect(lines[lines.length - 1]).toBe(lines[0]);
    expect(lines.every((line) => line.length === lines[0].length)).toBe(true);
  });

  describe('when the releases document cannot be downloaded', () => {
    // The document that is shipped with the compiler is used instead, and the CLI works as usual.
    test.each([
      ['it is not found', { statusCode: 404 }],
      ['the server fails', { statusCode: 500, statusMessage: 'Internal Server Error' }],
      ['the response fails', { statusCode: 200, error: new Error('connection reset') }],
      ['the request is aborted', { requestEvent: 'abort' as const }],
      ['the request times out', { requestEvent: 'timeout' as const }],
      ['the request fails', { requestEvent: 'error' as const, error: new Error('offline') }],
    ])('falls back to the built-in document when %s', async (_name, response) => {
      fakeReleasesServer(response);

      const result = await runCliWithEnv({ JSII_SILENCE_SUPPORT_WARNING: undefined }, projectDir, '--version');

      expect(result.stdout).toMatch(/^\d+\.\d+\.\d+ /);
      expect(result.stderr).not.toContain('Could not download');
    });

    test('reports the reason when JSII_DEBUG is set', async () => {
      fakeReleasesServer({ statusCode: 500, statusMessage: 'Internal Server Error' });

      expect(await supportNotice({ JSII_DEBUG: '1' })).toContain(
        'Could not download releases.json from GitHub: received error response: HTTP 500 - Internal Server Error',
      );
    });
  });
});
