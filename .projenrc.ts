import { typescript } from 'projen';
import { ReleaseWorkflow } from './projenrc/release';

const project = new typescript.TypeScriptProject({
  projenrcTs: true,

  name: 'jsii',
  license: 'Apache-2.0',

  authorName: 'Amazon Web Services',
  authorUrl: 'https://aws.amazon.com',

  homepage: 'https://aws.github.io/jsii',
  repository: 'https://github.com/aws/jsii-compiler.git',

  minNodeVersion: '14.6.0',
  typescriptVersion: '~4.9',
  tsconfig: {
    compilerOptions: {
      // @see https://github.com/microsoft/TypeScript/wiki/Node-Target-Mapping
      lib: ['es2020', 'es2021.WeakRef'],
      target: 'ES2020',

      esModuleInterop: false,
      skipLibCheck: true,
    },
  },

  autoDetectBin: true,

  release: false, // We have our own release workflow
  defaultReleaseBranch: 'release',
});

(project.tsconfig!.compilerOptions! as any).types = ['jest', 'node'];
(project.tsconfigDev!.compilerOptions! as any).types = ['jest', 'node'];

project.addDeps(
  '@jsii/check-node',
  '@jsii/spec',
  'case',
  'chalk@^4',
  'fast-deep-equal',
  'log4js',
  'semver',
  'semver-intersect',
  'sort-json',
  'spdx-license-list',
  'yargs',
);

project.addDevDeps(
  '@actions/core',
  '@actions/github',
  '@types/clone',
  '@types/deep-equal',
  '@types/semver',
  'all-contributors-cli',
  'clone',
);

project.preCompileTask.exec('ts-node build-tools/code-gen.ts', { name: 'code-gen' });
project.gitignore.addPatterns('src/version.ts');

new ReleaseWorkflow(project);

project.synth();
