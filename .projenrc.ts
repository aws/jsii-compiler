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

  autoDetectBin: true,

  release: false, // We have our own release workflow
  defaultReleaseBranch: 'release',
});

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

new ReleaseWorkflow(project);

project.synth();
