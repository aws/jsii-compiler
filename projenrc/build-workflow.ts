import * as path from 'node:path';
import type * as checkNode from '@jsii/check-node/lib/constants';
import { github, typescript } from 'projen';

export interface BuildWorkflowOptions {
  /**
   * If true (the default), a second workflow will be registered to enable
   * "merge when ready" (a.k.a: auto-merge) on any "ready for review" PR (all
   * PRs that are not draft, and are in an "opened" or "re-opened" state). This
   * saves the maintainers from having to manually enable this.
   *
   * @default true
   */
  readonly autoMerge?: boolean;
}

export class BuildWorkflow {
  public constructor(project: typescript.TypeScriptProject, opts: BuildWorkflowOptions = {}) {
    const wf = project.github!.addWorkflow('build');
    wf.on({
      mergeGroup: {},
      pullRequest: {},
      workflowDispatch: {},
    });

    /* This is a hack because @jsii/check-node does not currently expose its constants... */
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NodeRelease } = require(path.resolve(
      require.resolve('@jsii/check-node/package.json'),
      '..',
      'lib',
      'constants.js',
    )) as typeof checkNode;

    wf.addJobs({
      'build': {
        env: { CI: 'true' },
        permissions: { contents: github.workflows.JobPermission.READ },
        runsOn: ['ubuntu-latest'],
        steps: [
          {
            name: 'Checkout',
            uses: 'actions/checkout@v3',
            with: {
              ref: '${{ github.event.pull_request.head.ref }}',
              repository: '${{ github.event.pull_request.head.repo.full_name }}',
            },
          },
          {
            name: 'Setup Node.js',
            uses: 'actions/setup-node@v3',
            with: {
              'node-version': project.minNodeVersion,
              'cache': 'yarn',
            },
          },
          {
            name: 'Install dependencies',
            run: 'yarn install --check-files',
          },
          { name: 'compile', run: 'npx projen pre-compile && npx projen compile && npx projen post-compile' },
          {
            name: 'Upload artifact',
            uses: 'actions/upload-artifact@v3',
            with: {
              name: 'build-output',
              path: [
                '${{ github.workspace }}',
                // Exclude node_modules to reduce artifact size (we won't use those anyway)...
                '!${{ github.workspace }}/node_modules',
                '!${{ github.workspace }}/fixtures/node_modules',
              ].join('\n'),
            },
          },
        ],
      },
      'matrix-test': {
        env: { CI: 'true' },
        strategy: {
          failFast: false,
          matrix: {
            domain: {
              'node-version': NodeRelease.ALL_RELEASES.flatMap((release) => {
                if (!release.supported) {
                  return [];
                }
                return [`${release.majorVersion}.x`];
              }),
            },
          },
        },
        name: 'test (node ${{ matrix.node-version }})',
        needs: ['build'],
        permissions: {},
        runsOn: ['ubuntu-latest'],
        steps: [
          {
            name: 'Download artifact',
            uses: 'actions/download-artifact@v3',
            with: { name: 'build-output', path: '${{ github.workspace }}' },
          },
          {
            name: 'Setup Node.js',
            uses: 'actions/setup-node@v3',
            with: {
              'node-version': '${{ matrix.node-version }}',
              'cache': 'yarn',
            },
          },
          {
            name: 'Install dependencies',
            run: 'yarn install --frozen-lockfile',
          },
          // Re-run post-compile to ensure /fixtures/ symlinks are correctly present...
          {
            name: 'Re-run post-compile',
            run: 'npx projen post-compile',
          },
          { name: 'Test', run: 'npx projen test' },
          {
            name: 'Assert clean working directory',
            run: 'git diff --staged --exit-code',
          },
        ],
      },
      'package': {
        env: { CI: 'true' },
        name: 'package',
        needs: ['build'],
        permissions: {},
        runsOn: ['ubuntu-latest'],
        steps: [
          {
            name: 'Download artifact',
            uses: 'actions/download-artifact@v3',
            with: { name: 'build-output', path: '${{ github.workspace }}' },
          },
          {
            name: 'Setup Node.js',
            uses: 'actions/setup-node@v3',
            with: {
              'node-version': project.minNodeVersion,
              'cache': 'yarn',
            },
          },
          {
            name: 'Install dependencies',
            run: 'yarn install --frozen-lockfile',
          },
          {
            name: 'Package',
            run: 'npx projen package',
          },
          {
            name: 'Upload artifact',
            uses: 'actions/upload-artifact@v3',
            with: {
              name: 'release-package',
              path: '${{ github.workspace }}/dist',
            },
          },
        ],
      },
    });

    if (opts.autoMerge ?? true) {
      const autoMerge = project.github!.addWorkflow('auto-merge');
      autoMerge.runName = 'Enable "Merge when ready" on PR #${{ github.event.number }}';
      autoMerge.on({
        pullRequestTarget: {
          types: ['opened', 'reopened', 'ready_for_review'],
        },
      });
      autoMerge.addJob('enable-auto-merge', {
        env: { CI: 'true' },
        name: 'Enable "Merge when ready" for this PR',
        permissions: {
          pullRequests: github.workflows.JobPermission.WRITE,
          contents: github.workflows.JobPermission.WRITE,
        },
        runsOn: ['ubuntu-latest'],
        steps: [
          {
            uses: 'peter-evans/enable-pull-request-automerge@v2',
            with: {
              'token': '${{ secrets.PROJEN_GITHUB_TOKEN }}',
              'pull-request-number': '${{ github.event.number }}',
              'merge-method': 'squash',
            },
          },
        ],
      });
    }
  }
}
