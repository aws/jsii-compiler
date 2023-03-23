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
  cache: 'npm' | 'yarn' | `\${{${string}}}` | false = 'yarn',
): github.workflows.JobStep {
  return {
    name: 'Setup Node.js',
    uses: 'actions/setup-node@v3',
    with: {
      'cache': cache || undefined,
      'node-version': nodeVersion,
    },
  };
}

export function YARN_INSTALL(
  mode: '--check-files' | '--frozen-lockfile' = '--frozen-lockfile',
): github.workflows.JobStep {
  return {
    name: 'Install dependencies',
    run: `yarn install ${mode}`,
  };
}
