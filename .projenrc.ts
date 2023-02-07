import { javascript, typescript } from 'projen';
import { MatrixTest } from './projenrc/matrix-test';
import { ReleaseWorkflow } from './projenrc/release';

const project = new typescript.TypeScriptProject({
  projenrcTs: true,

  name: 'jsii',
  license: 'Apache-2.0',

  authorName: 'Amazon Web Services',
  authorUrl: 'https://aws.amazon.com',

  homepage: 'https://aws.github.io/jsii',
  repository: 'https://github.com/aws/jsii-compiler.git',

  autoDetectBin: true,

  minNodeVersion: '14.18.0',
  tsconfig: {
    compilerOptions: {
      // @see https://github.com/microsoft/TypeScript/wiki/Node-Target-Mapping
      lib: ['es2020', 'es2021.WeakRef'],
      target: 'ES2020',

      esModuleInterop: false,
      skipLibCheck: true,
    },
  },

  prettier: true,
  prettierOptions: {
    ignoreFile: false,
    settings: {
      bracketSpacing: true,
      printWidth: 120,
      quoteProps: javascript.QuoteProps.CONSISTENT,
      semi: true,
      singleQuote: true,
      tabWidth: 2,
      trailingComma: javascript.TrailingComma.ALL,
    },
  },

  release: false, // We have our own release workflow
  defaultReleaseBranch: 'release',
});

// Remove TypeScript devDependency (it's a direct/normal dependency here)
project.deps.removeDependency('typescript');

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
  'typescript',
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
  'eslint-plugin-unicorn',
);

project.preCompileTask.exec('ts-node build-tools/code-gen.ts', {
  name: 'code-gen',
});
project.gitignore.addPatterns('src/version.ts');

// Exclude negatives from tsconfig and eslint...
project.tsconfigDev.addExclude('test/negatives/**/*.ts');
project.eslint?.addIgnorePattern('test/negatives/**/*.ts');

// Customize ESLint rules
project.tsconfigDev.addInclude('build-tools/**/*.ts');
project.eslint!.rules!['no-bitwise'] = ['off']; // The TypeScript compiler API leverages some bit-flags.
(project.eslint!.rules!.quotes = ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }]),
  // Add Unicorn rules (https://github.com/sindresorhus/eslint-plugin-unicorn#rules)
  project.eslint?.addPlugins('unicorn');
project.eslint?.addRules({
  'unicorn/prefer-node-protocol': ['error'],
  'unicorn/no-array-for-each': ['error'],
  'unicorn/no-unnecessary-await': ['error'],
});

// Add Node.js version matrix test
new MatrixTest(project);

// Add the custom release workflow
new ReleaseWorkflow(project);

project.synth();
