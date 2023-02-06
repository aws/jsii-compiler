import { github, typescript } from 'projen';

export class ReleaseWorkflow {
  public constructor(project: typescript.TypeScriptProject) {
    new ReleaseTask(project);

    let release = project.github!.addWorkflow('release');

    release.on({
      push: {
        tags: [
          'v*.*.*-*.*', // E.g: v5.0.0-pre.1
        ],
      },
    });

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

    release.addJob('build', {
      name: 'Build release package',
      env: {
        CI: 'true',
      },
      outputs: {
        'dist-tag': { stepId: 'publish-target', outputName: 'dist-tag' },
        'registry': { stepId: 'publish-target', outputName: 'registry' },
        'prerelease': { stepId: 'publish-target', outputName: 'prerelease' },
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
          id: 'publish-target',
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
      needs: ['build'],
      permissions: {},
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
          name: 'Create Release',
          if: "steps.release-exists.outputs.result == 'false'",
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

    release.addJob('release-to-npmjs', {
      name: 'Release to npmjs.com',
      env: {
        CI: 'true',
      },
      needs: ['build'],
      permissions: {
        contents: github.workflows.JobPermission.WRITE,
        packages: github.workflows.JobPermission.WRITE,
      },
      runsOn: ['ubuntu-latest'],
      steps: [
        setupNodeStep,
        downloadArtifactStep,
        installDepsStep,
        {
          name: 'Release',
          env: {
            NPM_DIST_TAG: '${{ needs.build.outputs.dist-tag }}',
            NPM_REGISTRY: '${{ needs.build.outputs.registry }}',
            NPM_TOKEN: '${{ secrets.NPM_TOKEN }}',
          },
          run: 'npx -p publib@latest publib-npm',
        },
        {
          name: 'Tag "latest"',
          if: "needs.build.outputs.latest == 'true'",
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

    task.exec(
      'ts-node projenrc/set-version.ts',
      {
        name: 'set-version',
        receiveArgs: true,
      },
    );

    task.spawn(project.preCompileTask);
    task.spawn(project.compileTask);
    task.spawn(project.postCompileTask);

    task.spawn(project.packageTask);

    task.exec(
      'yarn version --no-git-tag-version --new-version 0.0.0',
      {
        name: 'reset-version',
      },
    );
  }
}
