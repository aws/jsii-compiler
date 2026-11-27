import { EventEmitter } from 'node:events';

import { emitSupportPolicyInformation } from '../../../src/support';
import { RELEASE_LINE } from '../../../src/version';
import { OutputCapture } from '../../output-helpers';

// Only the network is faked: the answers of GitHub. The factory hands over to a function that each test sets.
jest.mock('node:https', () => ({ get: (...args: unknown[]) => (globalThis as any).__fakeHttpsGet(...args) }));

const RELEASES_URL = 'https://raw.githubusercontent.com/aws/jsii-compiler/main/releases.json';

interface FakeResponse {
  readonly statusCode: number;
  readonly statusMessage?: string;
  readonly body?: string;
  /** Emitted on the response instead of delivering the body. */
  readonly error?: Error;
}

/**
 * Replaces `https.get` with a fake that answers the releases document request.
 *
 * @param respond what the fake server answers, or an error to be emitted by the request itself.
 */
function fakeReleasesServer(respond: FakeResponse | { requestEvent: 'abort' | 'timeout' | 'error'; error?: Error }) {
  (globalThis as any).__fakeHttpsGet = (url: URL, callback: (response: EventEmitter) => void) => {
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
    expect(url.toString()).toBe(RELEASES_URL);
    return request;
  };
}

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
    maintenance[RELEASE_LINE] = options.supportedUntil;
  }
  return JSON.stringify({
    current: options.current ?? '99.0',
    maintenance,
    ...(options.endOfSupport ? { endOfSupport: [RELEASE_LINE] } : {}),
  });
}

describe('emitSupportPolicyInformation', () => {
  let capture: OutputCapture;

  beforeEach(() => {
    delete process.env.JSII_SILENCE_SUPPORT_WARNING;
    delete process.env.JSII_DEBUG;
    capture = new OutputCapture('error');
    jest.useFakeTimers({ now: new Date('2026-06-15T12:00:00.000Z'), doNotFake: ['setImmediate', 'nextTick'] });
  });

  afterEach(() => {
    jest.useRealTimers();
    capture.stop();
    delete process.env.JSII_SILENCE_SUPPORT_WARNING;
    delete process.env.JSII_DEBUG;
  });

  const printed = () => capture.output;

  test('does nothing when silenced', async () => {
    process.env.JSII_SILENCE_SUPPORT_WARNING = '1';
    fakeReleasesServer({ statusCode: 200, body: releases({ endOfSupport: true }) });

    await emitSupportPolicyInformation();

    expect(printed()).toBe('');
  });

  test('does nothing when the compiler is on the current release line', async () => {
    fakeReleasesServer({ statusCode: 200, body: releases({ current: RELEASE_LINE }) });

    await emitSupportPolicyInformation();

    expect(printed()).toBe('');
  });

  test('does nothing when the status of the release line is unknown', async () => {
    fakeReleasesServer({ statusCode: 200, body: releases({}) });

    await emitSupportPolicyInformation();

    expect(printed()).toBe('');
  });

  test('does nothing when End-of-Support is more than 30 days away', async () => {
    fakeReleasesServer({ statusCode: 200, body: releases({ supportedUntil: '2026-08-01T00:00:00.000Z' }) });

    await emitSupportPolicyInformation();

    expect(printed()).toBe('');
  });

  test('warns when End-of-Support is less than 30 days away', async () => {
    fakeReleasesServer({ statusCode: 200, body: releases({ supportedUntil: '2026-07-01T00:00:00.000Z' }) });

    await emitSupportPolicyInformation();

    expect(printed()).toContain(
      `The ${RELEASE_LINE} release line of jsii will reach End-of-Support soon, on 2026-07-01.`,
    );
    expect(printed()).toContain('upgrade to the current release line (99.0)');
    expect(printed()).toContain('Other actively supported release lines include:');
    expect(printed()).toContain('- 98.0 (planned End-of-Support date: 2999-01-01)');
    expect(printed()).toContain('- 98.1 (planned End-of-Support date: 2999-06-30)');
    expect(printed()).not.toContain('97.0');
  });

  test('warns when End-of-Support has passed', async () => {
    fakeReleasesServer({ statusCode: 200, body: releases({ supportedUntil: '2026-06-01T00:00:00.000Z' }) });

    await emitSupportPolicyInformation();

    expect(printed()).toContain(`The ${RELEASE_LINE} release line of jsii has reached End-of-Support.`);
    expect(printed()).toContain('upgrade to the current release line (99.0)');
  });

  test('warns when the release line is listed as end-of-support', async () => {
    fakeReleasesServer({ statusCode: 200, body: releases({ endOfSupport: true }) });

    await emitSupportPolicyInformation();

    expect(printed()).toContain(`The ${RELEASE_LINE} release line of jsii has reached End-of-Support.`);
  });

  test('does not list alternatives when no other release line is supported long enough', async () => {
    fakeReleasesServer({
      statusCode: 200,
      body: JSON.stringify({ current: '99.0', maintenance: {}, endOfSupport: [RELEASE_LINE] }),
    });

    await emitSupportPolicyInformation();

    expect(printed()).toContain('has reached End-of-Support');
    expect(printed()).not.toContain('Other actively supported release lines include:');
  });

  test('surrounds the message with a border', async () => {
    fakeReleasesServer({ statusCode: 200, body: releases({ endOfSupport: true }) });

    await emitSupportPolicyInformation();

    const lines = printed().split('\n');
    expect(lines[0]).toMatch(/^!+$/);
    expect(lines[lines.length - 1]).toBe(lines[0]);
    expect(lines.every((line) => line.length === lines[0].length)).toBe(true);
  });

  describe('when the releases document cannot be downloaded', () => {
    // The document that is shipped with the compiler is used instead. Since it does not know about the
    // release line "99.0", the compiler's own release line is the one that is described there (or not).
    test.each([
      ['it is not found', { statusCode: 404 }],
      ['the server fails', { statusCode: 500, statusMessage: 'Internal Server Error' }],
      ['the response fails', { statusCode: 200, error: new Error('connection reset') }],
      ['the request is aborted', { requestEvent: 'abort' as const }],
      ['the request times out', { requestEvent: 'timeout' as const }],
      ['the request fails', { requestEvent: 'error' as const, error: new Error('offline') }],
    ])('falls back to the built-in document when %s', async (_name, response) => {
      fakeReleasesServer(response);

      await expect(emitSupportPolicyInformation()).resolves.toBeUndefined();
    });

    test('reports the reason when JSII_DEBUG is set', async () => {
      process.env.JSII_DEBUG = '1';
      fakeReleasesServer({ statusCode: 500, statusMessage: 'Internal Server Error' });

      await emitSupportPolicyInformation();

      expect(printed()).toContain(
        'Could not download releases.json from GitHub: received error response: HTTP 500 - Internal Server Error',
      );
    });

    test('is quiet about the reason when JSII_DEBUG is not set', async () => {
      fakeReleasesServer({ statusCode: 500, statusMessage: 'Internal Server Error' });

      await emitSupportPolicyInformation();

      expect(printed()).not.toContain('Could not download');
    });
  });
});
