import { github, typescript } from 'projen';

export const enum PublishTargetOutput {
  DIST_TAG = 'dist-tag',
  GITHUB_RELEASE = 'github-release',
  IS_LATEST = 'latest',
  IS_PRERELEASE = 'prerelease',
}

// The ARN of the OpenPGP key used to sign release artifacts uploaded to GH Releases.
const CODE_SIGNING_USER_ID = 'aws-jsii@amazon.com';

export class ReleaseWorkflow {
  public constructor(project: typescript.TypeScriptProject) {
    new ReleaseTask(project);
    new TagReleaseTask(project);

    let release = project.github!.addWorkflow('release');

    release.runName = 'Release ${{ github.ref_name }}';

    release.on({ push: { tags: ['v*.*.*'] } });

    const installDepsStep: github.workflows.JobStep = {
      name: 'Install dependencies',
      run: 'yarn install --frozen-lockfile',
    };
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
        contents: github.workflows.JobPermission.READ,
      },
      runsOn: ['ubuntu-latest'],
      steps: [
        {
          name: 'Checkout',
          uses: 'actions/checkout@v3',
        },
        {
          name: 'Setup Node.js',
          uses: 'actions/setup-node@v3',
          with: {
            'cache': 'yarn',
            'node-version': project.minNodeVersion,
          },
        },
        installDepsStep,
        {
          name: 'Prepare Release',
          run: 'yarn release ${{ github.ref_name }}',
        },
        {
          name: 'Determine Target',
          id: publishTarget,
          run: 'yarn ts-node projenrc/publish-target.ts ${{ github.ref_name }}',
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
            )} --detach-sign --armor --passphrase-fd=0 \${file}`,
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
        },
        {
          name: 'Attach assets',
          run: [
            'gh release upload ${{ github.ref_name }}',
            '--repo=${{ github.repository }}',
            '--clobber',
            '${{ github.workspace }}/**/*',
          ].join(' '),
        },
      ],
    });

    release.addJob('release-npm-package', {
      name: `Release to registry.npmjs.org`,
      env: {
        CI: 'true',
      },
      needs: ['build'],
      permissions: {},
      runsOn: ['ubuntu-latest'],
      steps: [
        downloadArtifactStep,
        {
          name: 'Setup Node.js',
          uses: 'actions/setup-node@v3',
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
