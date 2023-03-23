import { github } from 'projen';

export const ACTIONS_CHECKOUT: github.workflows.JobStep = {
  name: 'Checkout',
  uses: 'actions/checkout@v3',
  with: {
    ref: '${{ github.sha }}',
    repository: '${{ github.repository }}',
  },
};

export function ACTIONS_SETUP_NODE(
  nodeVersion?: string,
  packageManager: 'npm' | 'yarn' | `\${{${string}}}` = 'yarn',
): github.workflows.JobStep {
  return {
    name: 'Setup Node.js',
    uses: 'actions/setup-node@v3',
    with: {
      'cache': packageManager,
      'node-version': nodeVersion,
    },
  };
}

export const YARN_INSTALL: github.workflows.JobStep = {
  name: 'Install dependencies',
  run: 'yarn install --frozen-lockfile',
};
