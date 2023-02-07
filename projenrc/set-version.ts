import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import { parse } from 'semver';
import { versionMajorMinor } from 'typescript';

if (process.argv.length !== 3) {
  console.error('Usage: yarn release <semver-version-string>');
  process.exit(2);
}

const semver = parse(process.argv[2]);
if (semver == null) {
  console.error(`Invalid SemVer version string: ${process.argv[2]}`);
  process.exit(2);
}

// Verify that the version has the same major.minor as the TypeScript compiler.
if (versionMajorMinor !== `${semver.major}.${semver.minor}`) {
  console.error(`Version ${semver.raw} is incorrect. It should have a major.minor equal to ${versionMajorMinor}`);
  process.exit(2);
}

const { error, status, signal } = spawnSync(
  'yarn',
  [
    'version',
    '--no-git-tag-version',
    '--new-version', semver.version,
  ],
  { stdio: 'inherit' },
);

if (error != null) {
  throw error;
}

if (status !== 0) {
  const condition = signal != null
    ? `signal ${signal}`
    : `exit code ${status}`;
  console.error(`yarn version failed with ${condition}`);
  process.exit(status ?? (128 + os.constants.signals[signal!]));
}
