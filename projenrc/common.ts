import { github } from 'projen';

interface CheckoutOptions {
  readonly 'repository'?: string;
  readonly 'token'?: string;
  readonly 'ssh-key'?: string;
  readonly 'ssh-known-hosts'?: string;
  readonly 'ssh-strict'?: boolean;
  readonly 'persist-credentials'?: boolean;
  readonly 'path'?: string;
  readonly 'clean'?: boolean;
  readonly 'fecth-depth'?: number;
  readonly 'lfs'?: boolean;
  readonly 'submodules'?: boolean;
  readonly 'set-safe-directory'?: boolean;
  readonly 'github-server-url'?: string;
}

export function ACTIONS_CHECKOUT(ref = '${{ github.ref }}', opts?: CheckoutOptions): github.workflows.JobStep {
  return {
    name: 'Checkout',
    uses: 'actions/checkout@v3',
    with: {
      repository: '${{ github.repository }}',
      ...opts,
      ref,
    },
  };
}

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
