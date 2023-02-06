import { spawnSync } from 'child_process';
import * as os from 'os';
import { parse } from 'semver';

if (process.argv.length !== 3) {
  console.error('Usage: yarn release <semver-version-string>');
  process.exit(2);
}

const semver = parse(process.argv[2]);
if (semver == null) {
  console.error(`Invalid SemVer version string: ${process.argv[2]}`);
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
