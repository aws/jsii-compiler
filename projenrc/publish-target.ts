import * as core from '@actions/core';
import * as gh from '@actions/github';
import { parse } from 'semver';
import { PublishTargetOutput } from './release';

(async function () {
  if (process.argv.length !== 3) {
    console.error('Usage: yarn release <semver-version-string>');
    process.exit(2);
  }

  const semver = parse(process.argv[2]);
  if (semver == null) {
    console.error(`Invalid SemVer version string: ${process.argv[2]}`);
    process.exit(2);
  }

  const prerelease = semver.prerelease.length > 0;

  // We follow TypeScript versions, so major.minor is the effective "major".
  const tagBase = `v${semver.major}.${semver.minor}`;

  const latest = prerelease
    ? false
    : await (async function () {
        if (!process.env.GITHUB_TOKEN) {
          console.error('Missing GITHUB_TOKEN environment variable. This is required!');
          process.exit(2);
        }
        const octokit = gh.getOctokit(process.env.GITHUB_TOKEN);

        const latestRelease = (await octokit.paginate(octokit.rest.repos.listReleases, gh.context.repo))
          // Filter out draft releases
          .filter((release) => !release.draft)
          // Parse out the tags as SemVer instances
          .map((release) => parse(release.tag_name)!)
          // Sort by SemVer order (in reverse so the greatest appears first)
          .sort((l, r) => -l.compare(r))
          // First non-prerelease is the latest release per SemVer order
          .find((release) => release.prerelease.length === 0);

        return latestRelease == null
          ? // If there's no existing "latest" release, then this is it now...
            true
          : // Otherwise, it's the new "latest" if it's SemVer-greater than the current one.
            semver.compare(latestRelease) >= 0;
      })();

  // NB: Tag names can't be valid SemVer ranges (v#.# would be one).
  const distTag = prerelease
    ? // Pre-release, publish to next
      `${tagBase}-next`
    : // Not a pre-releaase, publish to latest on npmjs.com
      `${tagBase}-latest`;

  core.setOutput(PublishTargetOutput.DIST_TAG, distTag);
  core.setOutput(PublishTargetOutput.IS_LATEST, latest);
  core.setOutput(PublishTargetOutput.IS_PRERELEASE, prerelease);
  core.setOutput(PublishTargetOutput.GITHUB_RELEASE, semver.prerelease?.[0] !== 'dev');
})().catch((err) => {
  console.error(err);
  process.exit(255);
});
