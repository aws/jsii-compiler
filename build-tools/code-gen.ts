import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import * as os from 'os';
import { join } from 'path';
import * as gh from '@actions/github';

const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

const { commit, suffix } = (function () {
  if (gh.context.sha) {
    return { commit: gh.context.sha, suffix: '' };
  }

  const revParse = spawnSync(
    'git',
    ['rev-parse', '--verify', 'HEAD'],
    {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  if (revParse.error != null) {
    throw revParse.error;
  }
  if (revParse.status !== 0) {
    const description = revParse.signal != null
      ? `signal ${revParse.signal}`
      : `exit code ${revParse.status}`;
    console.error(`git rev-parse failed with ${description}`);
    process.exit(revParse.status ?? (128 + os.constants.signals[revParse.signal!]));
  }

  const diffStat = spawnSync(
    'git',
    ['diff', '--stat', '--exit-code'],
    { stdio: 'ignore' },
  );
  if (diffStat.error != null) {
    throw diffStat.error;
  }
  if (diffStat.status == 0) {
    return { commit: revParse.stdout.trim(), suffix: '@local' };
  } else if (diffStat.status == 1) {
    return { commit: revParse.stdout.trim(), suffix: '@dirty' };
  } else {
    const description = diffStat.signal != null
      ? `signal ${diffStat.signal}`
      : `exit code ${diffStat.status}`;
    console.error(`git diff failed with ${description}`);
    process.exit(diffStat.status ?? (128 + os.constants.signals[diffStat.signal!]));
  }
})();

writeFileSync(join(__dirname, '..', 'src', 'version.ts'), [
  '// GENERATED: This file is generated by build-tools/code-gen.ts -- Do not edit by hand!',
  '',
  '/** The short version number for this JSII compiler (e.g: `X.Y.Z`) */',
  `export const SHORT_VERSION = '${version}';`,
  '',
  '/** The qualified version number for this JSII compiler (e.g: `X.Y.Z (build #######)`) */',
  `export const VERSION = '${version} (build ${commit.slice(0, 7)}${suffix})';`,
  '',
].join('\n'), 'utf-8');
