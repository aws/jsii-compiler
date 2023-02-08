import { github, typescript } from 'projen';

export const enum PublishTargetOutput {
  DIST_TAG = 'dist-tag',
  GITHUB_RELEASE = 'github-release',
  IS_LATEST = 'latest',
  IS_PRERELEASE = 'prerelease',
  REGISTRY = 'registry',
}

export class ReleaseWorkflow {
  public constructor(project: typescript.TypeScriptProject) {
    new ReleaseTask(project);

    let release = project.github!.addWorkflow('release');

    release.on({ push: { tags: ['v*.*.*'] } });

    const setupNodeStep: github.workflows.JobStep = {
      name: 'Setup Node.js',
      uses: 'actions/setup-node@v3',
      with: {
        'cache': 'yarn',
        'node-version': project.minNodeVersion,
      },
    };
    const installDepsStep: github.workflows.JobStep = {
      name: 'Install dependencies',
      run: 'yarn install --frozen-lockfile',
    };
    const releasePackageName = 'release-package';

    const publishTarget = 'publish-target';

    release.addJob('build', {
      name: 'Build release package',
      env: {
        CI: 'true',
      },
      outputs: {
        [PublishTargetOutput.DIST_TAG]: { stepId: publishTarget, outputName: PublishTargetOutput.DIST_TAG },
        [PublishTargetOutput.IS_LATEST]: { stepId: publishTarget, outputName: PublishTargetOutput.IS_LATEST },
        [PublishTargetOutput.GITHUB_RELEASE]: { stepId: publishTarget, outputName: PublishTargetOutput.GITHUB_RELEASE },
        [PublishTargetOutput.REGISTRY]: { stepId: publishTarget, outputName: PublishTargetOutput.REGISTRY },
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
        setupNodeStep,
        installDepsStep,
        {
          name: 'Prepare Release',
          run: 'yarn release ${{ github.ref_name }}',
        },
        {
          name: 'Upload artifact',
          uses: 'actions/upload-artifact@v3',
          with: {
            name: releasePackageName,
            path: 'dist',
          },
        },
        {
          name: 'Determine Target',
          id: publishTarget,
          run: 'yarn ts-node projen/publish-target.ts ${{ github.ref_name }}',
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
        setupNodeStep,
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
            'dist/js/jsii-*.tgz',
          ].join(' '),
        },
      ],
    });

    release.addJob('release-npm-package', {
      name: `Release to \${{ needs.build.outputs.${PublishTargetOutput.REGISTRY} }}`,
      env: {
        CI: 'true',
      },
      needs: ['build'],
      permissions: {
        packages: github.workflows.JobPermission.WRITE,
      },
      runsOn: ['ubuntu-latest'],
      steps: [
        downloadArtifactStep,
        {
          ...setupNodeStep,
          with: {
            ...setupNodeStep.with,
            'registry-url': `https://\${{ needs.build.outputs.${PublishTargetOutput.REGISTRY} }}`,
          },
        },
        ////////////////////////////////////////////////////////////////////////////////////////////
        // WARNING: all steps after this will have access to the NODE_AUTH_TOKEN, which means they
        // will be able to publish packages to the selected registry. Be sure to not run any
        // un-trusted code from now on!!
        ////////////////////////////////////////////////////////////////////////////////////////////
        {
          name: 'Determine Authentication',
          run: [
            `if [[ "\${{ needs.build.outputs.${PublishTargetOutput.REGISTRY} }}" == "registry.npmjs.org" ]];`,
            'then',
            '  echo "NODE_AUTH_TOKEN=${{ secrets.NPM_TOKEN }}" > $GITHUB_ENV',
            'else',
            '  echo "NODE_AUTH_TOKEN=${{ secrets.GITHUB_TOKEN }}" > $GITHUB_ENV',
            'fi',
          ].join('\n'),
        },
        {
          name: 'Publish',
          run: [
            'npm publish dist/js/jsii-*.tgz',
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

    task.spawn(project.packageTask);

    task.exec('yarn version --no-git-tag-version --new-version 0.0.0', {
      name: 'reset-version',
    });
  }
}
