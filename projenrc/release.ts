import { github, typescript } from 'projen';
import { ACTIONS_CHECKOUT, ACTIONS_SETUP_NODE, YARN_INSTALL } from './common';

export const enum PublishTargetOutput {
  DIST_TAG = 'dist-tag',
  GITHUB_RELEASE = 'github-release',
  IS_LATEST = 'latest',
  IS_PRERELEASE = 'prerelease',
}

// The ARN of the OpenPGP key used to sign release artifacts uploaded to GH Releases.
const CODE_SIGNING_USER_ID = 'aws-jsii@amazon.com';

export class ReleaseWorkflow {
  public constructor(private readonly project: typescript.TypeScriptProject) {
    new ReleaseTask(project);
    new TagReleaseTask(project);

    let release = project.github!.addWorkflow('release');

    release.runName = 'Release ${{ github.ref_name }}';

    release.on({ push: { tags: ['v*.*.*'] } });

    const releasePackageName = 'release-package';
    const publishTarget = 'publish-target';
    const federateToAwsStep: github.workflows.JobStep = {
      name: 'Federate to AWS',
      uses: 'aws-actions/configure-aws-credentials@v1',
      with: {
        'aws-region': 'us-east-1',
        'role-to-assume': '${{ secrets.AWS_ROLE_TO_ASSUME }}',
        'role-session-name': 'GHA-aws-jsii-compiler@${{ github.ref_name }}',
      },
    };

    release.addJob('build', {
      name: 'Build release package',
      env: {
        CI: 'true',
      },
      outputs: {
        [PublishTargetOutput.DIST_TAG]: { stepId: publishTarget, outputName: PublishTargetOutput.DIST_TAG },
        [PublishTargetOutput.IS_LATEST]: { stepId: publishTarget, outputName: PublishTargetOutput.IS_LATEST },
        [PublishTargetOutput.GITHUB_RELEASE]: { stepId: publishTarget, outputName: PublishTargetOutput.GITHUB_RELEASE },
        [PublishTargetOutput.IS_PRERELEASE]: { stepId: publishTarget, outputName: PublishTargetOutput.IS_PRERELEASE },
      },
      permissions: {
        idToken: github.workflows.JobPermission.WRITE,
        contents: github.workflows.JobPermission.READ,
      },
      runsOn: ['ubuntu-latest'],
      steps: [
        ACTIONS_CHECKOUT,
        ACTIONS_SETUP_NODE(project.minNodeVersion),
        YARN_INSTALL,
        {
          name: 'Prepare Release',
          run: 'yarn release ${{ github.ref_name }}',
        },
        {
          name: 'Determine Target',
          id: publishTarget,
          run: 'yarn ts-node projenrc/publish-target.ts ${{ github.ref_name }}',
          env: {
            // A GitHub token is required to list GitHub Releases, so we can tell if the `latest` dist-tag is needed.
            GITHUB_TOKEN: '${{ github.token }}',
          },
        },
        {
          ...federateToAwsStep,
          // Only necessary if we're going to be publishing assets to GitHub Releases.
          if: `fromJSON(steps.publish-target.outputs.${PublishTargetOutput.GITHUB_RELEASE})`,
        },
        {
          name: 'Sign Tarball',
          if: `fromJSON(steps.publish-target.outputs.${PublishTargetOutput.GITHUB_RELEASE})`,
          run: [
            'set -eo pipefail',
            // First, we're going to be configuring GPG "correctly"
            'export GNUPGHOME=$(mktemp -d)',
            'echo "charset utf-8"   >  ${GNUPGHOME}/gpg.conf',
            'echo "no-comments"     >> ${GNUPGHOME}/gpg.conf',
            'echo "no-emit-version" >> ${GNUPGHOME}/gpg.conf',
            'echo "no-greeting"     >> ${GNUPGHOME}/gpg.conf',
            // Now, we need to import the OpenPGP private key into the keystore
            'secret=$(aws secretsmanager get-secret-value --secret-id=${{ secrets.OPEN_PGP_KEY_ARN }} --query=SecretString --output=text)',
            'privatekey=$(node -p "(${secret}).PrivateKey")',
            'passphrase=$(node -p "(${secret}).Passphrase")',
            'echo "::add-mask::${passphrase}"', // !!! IMPORTANT !!! (Ensures the value does not leak into public logs)
            'unset secret',
            'echo ${passphrase} | gpg --batch --yes --import --armor --passphrase-fd=0 <(echo "${privatekey}")',
            'unset privatekey',
            // Now we can actually detach-sign the artifacts
            'for file in $(find dist -type f -not -iname "*.asc"); do',
            `  echo \${passphrase} | gpg --batch --yes --local-user=${JSON.stringify(
              CODE_SIGNING_USER_ID,
            )} --detach-sign --armor --pinentry-mode=loopback --passphrase-fd=0 \${file}`,
            'done',
            'unset passphrase',
            // Clean up the GnuPG home directory (secure-wipe)
            'find ${GNUPGHOME} -type f -exec shred --remove {} \\;',
          ].join('\n'),
        },
        {
          name: 'Upload artifact',
          uses: 'actions/upload-artifact@v3',
          with: {
            name: releasePackageName,
            path: '${{ github.workspace }}/dist',
          },
        },
      ],
    });

    const downloadArtifactStep: github.workflows.JobStep = {
      name: 'Download artifact',
      uses: 'actions/download-artifact@v3',
      with: {
        name: releasePackageName,
      },
    };

    release.addJob('release-to-github', {
      name: 'Create GitHub Release',
      env: {
        CI: 'true',
      },
      if: `fromJSON(needs.build.outputs.${PublishTargetOutput.GITHUB_RELEASE})`,
      needs: ['build'],
      permissions: {
        contents: github.workflows.JobPermission.WRITE,
      },
      runsOn: ['ubuntu-latest'],
      steps: [
        downloadArtifactStep,
        {
          id: 'release-exists',
          name: 'Verify if release exists',
          run: [
            'if gh release view ${{ github.ref_name }} --repo=${{ github.repository }} &>/dev/null',
            'then',
            'echo "result=true" >> $GITHUB_OUTPUT',
            'else',
            'echo "result=false" >> $GITHUB_OUTPUT',
            'fi',
          ].join('\n'),
          env: {
            GH_TOKEN: '${{ github.token }}',
          },
        },
        {
          name: 'Create PreRelease',
          if: `!fromJSON(steps.release-exists.outputs.result) && fromJSON(needs.build.outputs.${PublishTargetOutput.IS_PRERELEASE})`,
          run: [
            'gh release create ${{ github.ref_name }}',
            '--repo=${{ github.repository }}',
            '--generate-notes',
            '--title=${{ github.ref_name }}',
            '--verify-tag',
            '--prerelease',
          ].join(' '),
          env: {
            GH_TOKEN: '${{ github.token }}',
          },
        },
        {
          name: 'Create Release',
          if: `!fromJSON(steps.release-exists.outputs.result) && !fromJSON(needs.build.outputs.${PublishTargetOutput.IS_PRERELEASE})`,
          run: [
            'gh release create ${{ github.ref_name }}',
            '--repo=${{ github.repository }}',
            '--generate-notes',
            '--title=${{ github.ref_name }}',
            '--verify-tag',
          ].join(' '),
          env: {
            GH_TOKEN: '${{ github.token }}',
          },
        },
        {
          name: 'Attach assets',
          run: [
            'gh release upload ${{ github.ref_name }}',
            '--repo=${{ github.repository }}',
            '--clobber',
            '${{ github.workspace }}/**/*',
          ].join(' '),
          env: {
            GH_TOKEN: '${{ github.token }}',
          },
        },
      ],
    });

    release.addJob('release-npm-package', {
      name: `Release to registry.npmjs.org`,
      env: {
        CI: 'true',
      },
      needs: ['build'],
      permissions: {
        idToken: github.workflows.JobPermission.WRITE,
        contents: github.workflows.JobPermission.READ,
      },
      runsOn: ['ubuntu-latest'],
      steps: [
        downloadArtifactStep,
        {
          ...ACTIONS_SETUP_NODE(),
          with: {
            'always-auth': true,
            'node-version': project.minNodeVersion,
            'registry-url': `https://registry.npmjs.org/`,
          },
        },
        federateToAwsStep,
        {
          name: 'Set NODE_AUTH_TOKEN',
          run: [
            'secret=$(aws secretsmanager get-secret-value --secret-id=${{ secrets.NPM_TOKEN_ARN }} --query=SecretString --output=text)',
            'token=$(node -p "(${secret}).token")',
            'unset secret',
            'echo "::add-mask::${token}"', // !!! IMPORTANT !!! (Ensures the value does not leak into public logs)
            'echo "NODE_AUTH_TOKEN=${token}" >> $GITHUB_ENV',
            'unset token',
          ].join('\n'),
        },
        {
          name: 'Publish',
          run: [
            'npm publish ${{ github.workspace }}/js/jsii-*.tgz',
            '--access=public',
            `--tag=\${{ needs.build.outputs.${PublishTargetOutput.DIST_TAG} }}`,
          ].join(' '),
        },
        {
          name: 'Tag "latest"',
          if: `fromJSON(needs.build.outputs.${PublishTargetOutput.IS_LATEST})`,
          run: 'npm dist-tag add jsii@${{ github.ref_name }} latest',
        },
      ],
    });
  }

  public autoTag(opts: AutoTagWorkflowProps): this {
    new AutoTagWorkflow(this.project, `auto-tag-releases${opts.branch ? `-${opts.branch}` : ''}`, opts);
    return this;
  }
}

class ReleaseTask {
  public constructor(project: typescript.TypeScriptProject) {
    const task = project.addTask('release', {
      description: 'Prepare a release bundle',
    });

    task.exec('ts-node projenrc/set-version.ts', {
      name: 'set-version',
      receiveArgs: true,
    });

    task.spawn(project.preCompileTask);
    task.spawn(project.compileTask);
    task.spawn(project.postCompileTask);

    task.spawn(project.testTask);

    task.spawn(project.packageTask);

    task.exec('yarn version --no-git-tag-version --new-version 0.0.0', {
      name: 'reset-version',
    });
  }
}

class TagReleaseTask {
  public constructor(project: typescript.TypeScriptProject) {
    const task = project.addTask('tag-release', {
      description: 'Tag this commit for release',
    });

    task.exec('ts-node projenrc/tag-release.ts', {
      name: 'tag-release',
      receiveArgs: true,
    });
  }
}

interface AutoTagWorkflowProps {
  /**
   * The branch on which to trigger this AutoTagWorkflow.
   *
   * @default - the repository's default branch
   */
  readonly branch?: string;

  /**
   * The schedule on which to run this AutoTagWorkflow instance.
   *
   * @see https://pubs.opengroup.org/onlinepubs/9699919799/utilities/crontab.html#tag_20_25_07
   *
   * @default none
   */
  readonly schedule?: string;

  /**
   * The run name to use for this workflow.
   *
   * @default - GitHub's default run name will be used.
   */
  readonly runName?: string;

  /**
   * The pre-release identifier to be used.
   *
   * @default - a regular release will be tagged.
   */
  readonly preReleaseId?: string;
}

class AutoTagWorkflow {
  public constructor(project: typescript.TypeScriptProject, name: string, props: AutoTagWorkflowProps) {
    const workflow = project.github!.addWorkflow(name);
    workflow.runName = props.runName;
    workflow.on({
      schedule:
        props.schedule != null
          ? [
              {
                cron: props.schedule,
              },
            ]
          : undefined,
      workflowDispatch: {},
    });
    workflow.addJob('pre-flight', {
      name: 'Pre-Flight Checks',
      runsOn: ['ubuntu-latest'],
      outputs: {
        sha: {
          stepId: 'git',
          outputName: 'sha',
        },
      },
      permissions: { contents: github.workflows.JobPermission.READ },
      steps: [
        { ...ACTIONS_CHECKOUT, with: { ...ACTIONS_CHECKOUT.with, ref: props.branch } },
        ACTIONS_SETUP_NODE(project.minNodeVersion),
        YARN_INSTALL,
        { name: 'Build', run: 'yarn build' },
        { id: 'git', name: 'Identify git SHA', run: 'echo sha=$(git rev-parse HEAD) >> $GITHUB_OUTPUT' },
      ],
    });
    workflow.addJob('auto-tag', {
      name: 'Auto-Tag Release',
      needs: ['pre-flight'],
      runsOn: ['ubuntu-latest'],
      permissions: {},
      steps: [
        {
          ...ACTIONS_CHECKOUT,
          with: {
            ...ACTIONS_CHECKOUT.with,
            ref: '${{ needs.pre-flight.outputs.sha }}',
            token: '${{ secrets.PROJEN_GITHUB_TOKEN }}',
          },
        },
        ACTIONS_SETUP_NODE(project.minNodeVersion),
        YARN_INSTALL,
        {
          name: 'Set git identity',
          run: ['git config user.name "github-actions"', 'git config user.email "github-actions@github.com"'].join(
            '\n',
          ),
        },
        {
          name: `Tag ${props.preReleaseId ? 'PreRelease' : 'Release'}`,
          run: `yarn tag-release --idempotent --no-sign --push ${
            props.preReleaseId ? `--prerelease=${props.preReleaseId}` : ''
          }`,
        },
      ],
    });
  }
}
