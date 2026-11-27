import { ProjectInfo } from '../../../src/project-info';

/**
 * Creates a minimal `ProjectInfo` for compiling the sources found in `sourceDir`, without needing a `package.json`.
 *
 * @param sourceDir the project root.
 * @param types     the `types` entry point of the project (for example `index.d.ts`).
 * @param overrides values to override in the returned `ProjectInfo`.
 */
export function makeProjectInfo(sourceDir: string, types: string, overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    projectRoot: sourceDir,
    description: 'test',
    homepage: 'https://github.com/aws/jsii-compiler',
    packageJson: {},
    types,
    main: types.replace(/(?:\.d)?\.ts(x?)/, '.js$1'),
    name: 'jsii',
    version: '0.0.1',
    jsiiVersionFormat: 'short',
    license: 'Apache-2.0',
    author: { name: 'John Doe', roles: ['author'] },
    repository: { type: 'git', url: 'https://github.com/aws/jsii.git' },
    dependencies: {},
    peerDependencies: {},
    dependencyClosure: [],
    bundleDependencies: {},
    targets: {},
    excludeTypescript: [],
    tsc: {
      inlineSourceMap: true,
      inlineSources: true,
    },
    ...overrides,
  };
}
