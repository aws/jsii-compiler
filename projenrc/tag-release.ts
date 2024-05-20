import { spawn } from 'node:child_process';
import { SemVer } from 'semver';
import { versionMajorMinor } from 'typescript';
import * as yargs from 'yargs';

type PrereleaseIdentifier = 'dev' | 'pre' | 'alpha' | 'beta' | 'rc';

async function main(): Promise<void> {
  const {
    dryRun,
    idempotent,
    'ignore-dirty': ignoreDirty,
    prerelease,
    push,
    remote,
    sign,
    verbose,
    releaseLine,
  } = await yargs
    .scriptName('npx projen tag-release')
    .option('idempotent', {
      type: 'boolean',
      desc: 'If the HEAD commit is already included in a tag, do nothing',
      default: true,
    })
    .option('ignore-dirty', {
      boolean: true,
      desc: 'Ignore un-committed local changes',
      default: false,
      hidden: true, // Don't advertise, this is "dangerous"
    })
    .option('prerelease', {
      alias: 'pre-release',
      type: 'string',
      desc: 'Use the specified pre-release identifier',
      choices: ['dev', 'pre', 'alpha', 'beta', 'rc'] as PrereleaseIdentifier[],
    })
    .option('push', {
      boolean: true,
      desc: 'Push the tag to the upstream after creating it',
      default: false,
      hidden: true, // Don't advertise, this is "dangerous"
    })
    .option('remote', {
      alias: 'upstream',
      type: 'string',
      desc: 'The remote/upstream to use for pulling and pushing',
      default: 'origin',
    })
    .option('sign', {
      boolean: true,
      desc: 'Sign the tag using GnuPG',
      default: true,
    })
    .option('verbose', {
      alias: 'v',
      type: 'boolean',
      desc: 'Turn on verbose logging',
      default: false,
    })
    .option('dry-run', {
      type: 'boolean',
      desc: 'Do not actually create a tag, just determine what it would be',
      default: false,
    })
    .option('release-line', {
      alias: 'r',
      type: 'string',
      desc: 'The version line for this release. This will be checked against the actual available typescript version and fail if they do not match. If not provided the current typescript version will be released.',
      default: versionMajorMinor,
    })
    .help().argv;

  if (verbose) {
    console.debug(`Expected release line: ${releaseLine}`);
    console.debug(`Detected release line: ${versionMajorMinor}`);
  }

  if (releaseLine !== versionMajorMinor) {
    throw new Error(`Release line mismatch: expected ${releaseLine}, got ${versionMajorMinor}`);
  }

  // Shell out to a git command and ensure it returns successfully, and returns
  // the captured standard output of it.
  function git(...args: string[]): Promise<string> {
    // Quote arguments that contain "special" characters (spaces, etc..), since
    // we have `shell: true` set as we want to be Windows-friendly.
    args = args.map((arg) => (/[^\w.-]/im.test(arg) ? JSON.stringify(arg) : arg));

    return new Promise((ok, ko) => {
      const command = `git ${args.join(' ')}`;
      if (verbose) {
        console.debug(`Shelling out: '${command}'`);
      }
      const child = spawn('git', args, { shell: true, stdio: ['inherit', 'pipe', 'inherit'] });

      const chunks = new Array<Buffer>();
      let totalLength = 0;
      child.stdout!.once('error', ko);
      child.stdout!.on('data', (chunk) => {
        chunk = Buffer.from(chunk);
        chunks.push(chunk);
        totalLength += chunk.length;
      });

      let stdoutResolve!: (value: string | PromiseLike<string>) => void;
      let stdoutReject!: (reason: any) => void;
      const stdout = new Promise<string>((resolve, reject) => {
        stdoutResolve = resolve;
        stdoutReject = reject;
      });
      child.stdout!.once('error', stdoutReject);
      child.stdout!.once('close', () => stdoutResolve(Buffer.concat(chunks, totalLength).toString('utf-8').trimEnd()));

      child.once('error', ko);
      child.once('close', (status, signal) => {
        if (status === 0) {
          return ok(
            verbose
              ? stdout.then((str) => {
                  console.debug(`Output of '${command}':`, str);
                  return str;
                })
              : stdout,
          );
        }
        const reason = signal != null ? `signal ${signal}` : `status ${status}`;
        ko(new Error(`'${command}' exited with ${reason}`));
      });
    });
  }

  // Check if the work-tree is dirty or not...
  const dirty = await git('diff', '--cached');
  if (dirty != '') {
    if (ignoreDirty) {
      console.warn('↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧↧');
      console.warn('WARNING: You have un-committed changes, and --ignore-dirty was specified...');
      console.warn(dirty);
      console.warn('WARNING: You have un-committed changes, and --ignore-dirty was specified...');
      console.warn('↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥↥');
    } else {
      throw new Error(`You have un-committed changes:\n\n${dirty}`);
    }
  }

  // Determine the current commit ID.
  const HEAD = await git('rev-parse', 'HEAD');
  if (verbose) {
    console.debug(`Current HEAD commit: ${HEAD}`);
  }

  // Existing tags in Github using the correct `versionMajorMinor`, sorted in
  // descending SemVer order.
  const tags = (await git('ls-remote', '--sort=-version:refname', remote, `refs/tags/v${versionMajorMinor}*`))
    .split('\n')
    .flatMap((line, index, array) => {
      if (line === '' && index === 0 && array.length === 1) {
        // If there are currently no tags, the output will have been empty, and
        // split will return an array with a single empty string item...
        return [];
      }
      const [commit, ref] = line.split(/\s+/);
      // The ref might be something like `refs/tags/v1.2.3^{}`, and the `^{}` is
      // called a "peeled ref", which allows us to know the commit ID associated
      // with an annotated tag (since those are what we create, it's important).
      // We still also look at the unpeeled refs in case non-peeled tags were
      // somehow created (e.g: manually).
      const tagName = ref.slice(10, ref.endsWith('^{}') ? -3 : undefined);
      return [
        {
          commit,
          tag: new SemVer(tagName),
        },
      ] as const;
    });

  if (verbose) {
    console.debug(
      `Found ${tags.length} tags:`,
      tags.map(({ tag }) => tag.raw),
    );
  }

  // Check that the current commit wasn't already tagged...
  const existingTag = tags.find((tag) => tag.commit === HEAD);
  if (existingTag != null) {
    const message = `Commit ${HEAD} was already tagged as ${existingTag.tag.version}!`;
    if (idempotent) {
      console.info(message);
      console.log('Idempotent success!');
      return;
    } else {
      throw new Error(message);
    }
  }

  // Make sure we have all remote tags pulled in.
  await git('fetch', remote, `refs/tags/v${versionMajorMinor}.*:refs/tags/v${versionMajorMinor}.*`);

  // Check whether there is already a local tag for the current commit... The
  // command will return the closest tag that contains the HEAD commit with
  // additional info on how many commits below it is, or if no tag was found, it
  // returns the unambiguously-abbreviated commit ID.
  const localTag = await git(
    'describe',
    '--always',
    '--contains',
    '--match',
    `v${versionMajorMinor}.*`,
    // If no prerelease identifier, ignore any prerelease tags (we're "upgrading" to a regular release)
    ...excludeLowerTags(prerelease),
    '--tags',
    HEAD,
  );
  if (localTag.startsWith(`v${versionMajorMinor}.`)) {
    const message = `Commit ${HEAD} is already included in tag ${localTag}!`;
    if (idempotent) {
      console.info(message);
      console.log('Idempotent success!');
      return;
    } else {
      throw new Error(message);
    }
  }

  // The latest release in this versionMajorMinor:
  const latestRelease = tags.find(({ tag }) => tag.prerelease.length === 0)?.tag;
  // The latest pre-release in this versionMajorMinor with the requested identifier:
  let latestPrerelease =
    prerelease != null
      ? tags.find(({ tag }) => {
          // If there's an "actual" release, and the pre-release is older than it, ignore it.
          if (latestRelease != null && latestRelease.compare(tag) > 0) {
            return false;
          }
          return tag.prerelease[0] === prerelease;
        })?.tag
      : undefined;

  if (verbose) {
    console.debug(`Latest release in line: ${latestRelease?.version ?? '<none>'}`);
    if (prerelease) {
      console.debug(`Latest ${prerelease} pre-release in line: ${latestPrerelease?.version ?? '<none>'}`);
    }
  }

  const { version } =
    prerelease != null
      ? (latestPrerelease ?? latestRelease)?.inc('prerelease', prerelease) ??
        new SemVer(`${versionMajorMinor}.0-${prerelease}.0`)
      : latestRelease?.inc('patch') ?? new SemVer(`${versionMajorMinor}.0`);

  if (verbose) {
    console.debug(`Determined version number: ${version}`);
  }

  if (dryRun) {
    console.log(`[DRY RUN] Would have tagged HEAD as: v${version}`);
    return;
  }

  await git('tag', '-a', `v${version}`, '-m', `Release ${version}`, ...(sign ? ['--sign'] : []), 'HEAD');

  if (!push) {
    console.log('You can now push the tag to origin using the following command:');
    console.log(`\tgit push origin v${version}`);
    return;
  }

  if (verbose) {
    console.debug(`Pushing tag to upstream '${push}'`);
  }
  await git('push', remote, `v${version}`);
}

/**
 * Computes the `--exclude` options to be passed tino `git describe` to filter
 * out any pre-release tags considered "inferior" to the current one, so that
 * releases may be published that upgrade an artifact from one prerelease tier
 * to the next tier (up to regular release).
 *
 * @param prerelease the prerelease identifier this is running for.
 * @param versionMajorMinor the major/minor version considered.
 *
 * @returns arguments to pass to `git describe`.
 */
function excludeLowerTags(prerelease: PrereleaseIdentifier | undefined): readonly string[] {
  switch (prerelease) {
    case 'dev':
    case 'pre':
      // -dev and -pre are the lowest rank. They can't be re-tagged as -dev or -pre.
      return [];
    case 'alpha':
      // -dev and -pre can be upgraded to -alpha.
      return excludeIdentifiers('dev', 'pre');
    case 'beta':
      // -dev, -pre and -alpha can be upgraded to -beta
      return excludeIdentifiers('dev', 'pre', 'alpha');
    case 'rc':
      // -dev, -pre, -alpha and -beta can be upgraded to -rv
      return excludeIdentifiers('dev', 'pre', 'alpha', 'beta');
    case undefined:
      // Regular release, ignore all prerelease tags.
      return ['--exclude', `v${versionMajorMinor}.*-*`];
  }

  function excludeIdentifiers(...toExclude: readonly PrereleaseIdentifier[]) {
    return toExclude.flatMap((id) => ['--exclude', `v${versionMajorMinor}.*-${id}.*`]);
  }
}

main().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = -1;
  },
);
