import { readFileSync } from 'node:fs';
import { get } from 'node:https';
import { join } from 'node:path';
import * as chalk from 'chalk';

import { RELEASE_LINE } from './version';

const SILENCE_ENV_VAR = 'JSII_SILENCE_SUPPORT_WARNING';
const THIRTY_DAYS_IN_MILLIS = 2_592_000_000;

/** @internal */
export interface ReleasesDocument {
  /**
   * The release line that occupies the 'Current' stage.
   */
  readonly current: ReleaseLine;
  /**
   * Release lines currently in 'Maintenance' with the date at which they are
   * planned to go into the 'End-of-Support' stage. This date should always be
   * set a minimum of 6 months in the future when a release line is added to the
   * list.
   */
  readonly maintenance: { readonly [release: ReleaseLine]: Date };
  /**
   * Release lines that are currently out-of-support. This is semantically
   * equivalent to being in the `maintenance` list with a past date, but offers
   * slightly faster look-up.
   */
  readonly endOfSupport?: readonly ReleaseLine[];
}

/**
 * Checks whether the current release line is close to End-of-Support (within
 * 30 days), or already in End-of-Support, and if that is the case, emits a
 * warning to call the user to action.
 *
 * It is possible for users to opt out of these notifications by setting the
 * `JSII_SILENCE_SUPPORT_WARNING` environment variable to any truthy value (that
 * is, any non-empty value).
 */
export async function emitSupportPolicyInformation() {
  if (process.env[SILENCE_ENV_VAR]) {
    return;
  }

  const data = await getReleasesDocument();

  if (data.current == RELEASE_LINE) {
    // Current release is not close to deprecation
    return;
  }

  const endOfSupportDate = data.endOfSupport?.includes(RELEASE_LINE) ? new Date(0) : data.maintenance[RELEASE_LINE];
  if (endOfSupportDate == null) {
    // Don't know the status, so don't say anything...
    return;
  }

  const now = new Date();
  const inThirtyDays = new Date(now.getTime() + THIRTY_DAYS_IN_MILLIS);
  const alternatives = Object.entries(data.maintenance)
    .flatMap(([release, dateStr]) => {
      const date = new Date(dateStr);
      if (date <= inThirtyDays) {
        return [];
      }
      return [{ release, date }];
    })
    .reduce((acc, { release, date }) => {
      if (acc.length === 0) {
        acc.push('', 'Other actively supported release lines include:');
      }
      acc.push(`- ${release} (planned End-of-Support date: ${date.toLocaleDateString()})`);
      return acc;
    }, new Array<string>());
  if (endOfSupportDate <= now) {
    // End-of-Support already!
    veryVisibleMessage(
      chalk.bgRed.white.bold,
      `The ${RELEASE_LINE} release line of jsii has reached End-of-Support.`,
      `We strongly recommend you upgrade to the current release line (${data.current}) at your earliest convenience.`,
      ...alternatives,
    );
  } else if (endOfSupportDate <= inThirtyDays) {
    // End-of-Support within 30 days!
    veryVisibleMessage(
      chalk.bgYellow.black,
      `The ${RELEASE_LINE} release line of jsii will reach End-of-Support soon, on ${endOfSupportDate.toLocaleDateString()}.`,
      `We strongly recommend you upgrade to the current release line (${data.current}) at your earliest convenience.`,
      ...alternatives,
    );
  }
}

/**
 * Downloads the latest `releases.json` document from 'https://raw.githubusercontent.com/aws/jsii-compiler/main/releases.json'
 * if possible, or falls back to the built-in version of that file if that fails in any way.
 */
async function getReleasesDocument(): Promise<ReleasesDocument> {
  const downloaded = await new Promise<string | undefined>((ok, ko) => {
    const request = get(
      new URL('https://raw.githubusercontent.com/aws/jsii-compiler/main/releases.json'),
      (response) => {
        if (response.statusCode === 404) {
          return ok(undefined);
        }
        if (response.statusCode !== 200) {
          return ko(`received error response: HTTP ${response.statusCode} - ${response.statusMessage}`);
        }
        response.once('error', ko);
        const chunks = new Array<Buffer>();
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.once('end', () => ok(Buffer.concat(chunks).toString('utf-8')));
      },
    );
    request.once('abort', () => ko('request aborted'));
    request.once('timeout', () => ko('request timed out'));
    request.once('error', ko);
    request.end();
  }).catch((cause) => {
    if (process.env.JSII_DEBUG) {
      console.error(`Could not download releases.json from GitHub: ${cause}`);
    }
    undefined;
  });

  return JSON.parse(downloaded ?? readFileSync(join(__dirname, '..', 'releases.json'), 'utf-8'), (key, value) => {
    if (key !== 'maintenance') {
      return value;
    }
    return Object.fromEntries(Object.entries(value).map(([release, date]) => [release, new Date(date as string)]));
  }) as ReleasesDocument;
}

function veryVisibleMessage(formatter: chalk.Chalk, ...lines: readonly string[]): void {
  if (lines.length === 0) {
    throw new Error(`At least one line of message must be provided!`);
  }

  const len = Math.max(...lines.map((line) => line.length));
  const border = formatter('!'.repeat(len + 8));
  const spacer = formatter(`!!  ${' '.repeat(len)}  !!`);

  console.error(border);
  console.error(spacer);
  for (const line of lines) {
    console.error(formatter(`!!  ${line.padEnd(len, ' ')}  !!`));
  }
  console.error(spacer);
  console.error(border);
}

type ReleaseLine = `${number}.${number}`;
