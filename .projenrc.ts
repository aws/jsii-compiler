import { javascript, JsonFile, JsonPatch, typescript } from 'projen';
import { BuildWorkflow } from './projenrc/build-workflow';
import { JsiiCalcFixtures } from './projenrc/fixtures';
import { ReleaseWorkflow } from './projenrc/release';
import { SupportPolicy } from './projenrc/support';

const project = new typescript.TypeScriptProject({
  projenrcTs: true,

  name: 'jsii',
  license: 'Apache-2.0',

  authorName: 'Amazon Web Services',
  authorUrl: 'https://aws.amazon.com',

  homepage: 'https://aws.github.io/jsii',
  repository: 'https://github.com/aws/jsii-compiler.git',

  pullRequestTemplateContents: [
    '',
    '',
    '---',
    '',
    'By submitting this pull request, I confirm that my contribution is made under the terms of the [Apache 2.0 license].',
    '',
    '[Apache 2.0 license]: https://www.apache.org/licenses/LICENSE-2.0',
  ],

  autoDetectBin: true,

  minNodeVersion: '14.18.0',
  tsconfig: {
    compilerOptions: {
      // @see https://github.com/microsoft/TypeScript/wiki/Node-Target-Mapping
      lib: ['es2020', 'es2021.WeakRef'],
      target: 'ES2020',

      esModuleInterop: false,
      noImplicitOverride: true,
      skipLibCheck: true,

      sourceMap: true,
      inlineSourceMap: false,
      inlineSources: true,
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

  jestOptions: {
    configFilePath: 'jest.config.json',
    jestConfig: {
      moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
      watchPathIgnorePatterns: [
        // NB: Those are regexes...
        '<rootDir>/fixtures/\\..*',
        '<rootDir>/fixtures/node_modules',
        '<rootDir>/fixtures/.*\\.d\\.ts',
        '<rootDir>/fixtures/.*\\.js',
        '<rootDir>/fixtures/.*\\.map',
      ],
    },
    junitReporting: false,
  },

  buildWorkflow: false, // We have our own build workflow (need matrix test)
  release: false, // We have our own release workflow
  defaultReleaseBranch: 'release',

  autoApproveUpgrades: true,
  autoApproveOptions: {
    allowedUsernames: ['aws-cdk-automation', 'github-bot'],
  },

  vscode: true,
});

// VSCode will look at the "closest" file named "tsconfig.json" when deciding on which config to use
// for a given TypeScript file with the TypeScript language server. In order to make this "seamless"
// we'll be dropping `tsconfig.json` files at strategic locations in the project. These will not be
// committed as they are only here for VSCode comfort.
for (const dir of ['build-tools', 'projenrc', 'test']) {
  new JsonFile(project, `${dir}/tsconfig.json`, {
    allowComments: true,
    committed: false,
    marker: true,
    obj: {
      extends: '../tsconfig.dev.json',
      references: [{ path: '../tsconfig.json' }],
    },
    readonly: true,
  });
}
project.tsconfig?.file?.patch(
  JsonPatch.add('/compilerOptions/composite', true),
  JsonPatch.add('/compilerOptions/declarationMap', true),
);

// Add support policy documents
new SupportPolicy(project);

// Don't show .gitignore'd files in the VSCode explorer
project.vscode!.settings.addSetting('explorer.excludeGitIgnore', true);
// Use the TypeScript SDK from the project dependencies
project.vscode!.settings.addSetting('typescript.tsdk', 'node_modules/typescript/lib');
// Format-on-save using ESLint
project.vscode!.extensions.addRecommendations('dbaeumer.vscode-eslint');
project.vscode!.settings.addSetting('editor.codeActionsOnSave', { 'source.fixAll.eslint': true });
project.vscode!.settings.addSetting('eslint.validate', ['typescript']);

// Exports map...
project.package.addField('exports', {
  '.': `./${project.package.entrypoint}`,
  './bin/jsii': './bin/jsii',
  './package.json': './package.json',
});

// Remove TypeScript devDependency (it's a direct/normal dependency here)
project.deps.removeDependency('typescript');

// Modernize ts-jest configuration
if (project.jest?.config?.globals?.['ts-jest']) {
  delete project.jest.config.globals['ts-jest'];
  project.jest.config.transform ??= {};
  project.jest.config.transform['^.+\\.tsx?$'] = [
    'ts-jest',
    {
      compiler: 'typescript',
      tsconfig: 'tsconfig.dev.json',
    },
  ];
}

// Add fixtures & other exemptions to npmignore
project.npmignore?.addPatterns(
  '/.*',
  '/CODE_OF_CONDUCT.md',
  '/CONTRIBUTING.md',
  '/build-tools/',
  '/fixtures/',
  '/projenrc/',
  '*.tsbuildinfo',
  '*.d.ts.map', // Declarations map aren't useful in published packages.
);

project.addDeps(
  '@jsii/check-node',
  '@jsii/spec',
  'case',
  'chalk@^4',
  'downlevel-dts',
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
  '@types/lockfile',
  '@types/semver',
  'all-contributors-cli',
  'clone',
  'eslint-plugin-unicorn',
  'jsii-1.x@npm:jsii@1',
  'lockfile',
);

project.preCompileTask.exec('ts-node build-tools/code-gen.ts', {
  name: 'code-gen',
});
project.gitignore.addPatterns('/src/version.ts', '/jsii-outdir/', '/test/negatives/.*');

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

// Register jsii-calc stuff in the work stream
new JsiiCalcFixtures(project);

// Add Node.js version matrix test
new BuildWorkflow(project);

// Add the custom release workflow
new ReleaseWorkflow(project)
  .autoTag({
    preReleaseId: 'dev',
    runName: 'Auto-Tag Prerelease (default branch)',
    schedule: '0 0 * * 0,2-6', // Tuesday though sundays at midnight
  })
  .autoTag({
    runName: 'Auto-Tag Release (default branch)',
    schedule: '0 0 * * 1', // Mondays at midnight
  });

project.synth();
