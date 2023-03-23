import * as assert from 'node:assert';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as glob from 'glob';
import { typescript } from 'projen';
import * as tar from 'tar';
import * as ts from 'typescript';
import * as yargs from 'yargs';
import { copySync } from './utils';

export class UpdateIntegPackage {
  public constructor(project: typescript.TypeScriptProject) {
    project.addDevDeps('@types/glob', '@types/tar', 'glob', 'tar', 'npm');

    project.addTask('test:benchmark:update-aws-cdk-lib-snapshot', {
      description: 'Updates the fixtures/.tarballs/aws-cdk-lib.tgz file with a fresh snapshot.',
      exec: 'ts-node projenrc/update-integ-package.ts',
      receiveArgs: true,
    });
  }
}

// Using the local `npm` package (from dependencies)
const npm = path.resolve(__dirname, '..', 'node_modules', '.bin', 'npm');

function snapshotAwsCdk(tag: string, file: string) {
  // Directory of aws-cdk repository
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), `jsii-cdk-bench@${tag}`));
  // Directory for snapshot of aws-cdk-lib source
  const intermediate = fs.mkdtempSync(path.join(os.tmpdir(), `jsii-cdk-bench-inter@${tag}`));

  // Clone aws/aws-cdk
  assert.strictEqual(
    0,
    cp.spawnSync('git', ['clone', '--depth=1', `--branch=${tag}`, 'https://github.com/aws/aws-cdk.git', repoDir], {
      stdio: ['ignore', 'inherit', 'inherit'],
    }).status,
  );

  // Install/link dependencies
  assert.strictEqual(
    0,
    cp.spawnSync('yarn', ['install', '--frozen-lockfile'], { cwd: repoDir, stdio: ['ignore', 'inherit', 'inherit'] })
      .status,
  );

  // build aws-cdk-lib and dependencies
  assert.strictEqual(
    0,
    cp.spawnSync(
      'yarn',
      [
        'lerna',
        'run',
        '--scope=aws-cdk-lib',
        '--include-dependencies',
        `--concurrency=${Math.max(os.cpus().length / 2, 2).toFixed()}`,
        '--stream',
        'build',
      ],
      {
        cwd: repoDir,
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    ).status,
  );

  // Copy built package to intermediate directory
  copySync(path.resolve(repoDir, 'packages', 'aws-cdk-lib'), intermediate);

  // Remove node_modules from monorepo setup
  fs.rmSync(path.resolve(intermediate, 'node_modules'), { force: true, recursive: true });

  // Remove build artifacts so we can rebuild
  const artifacts = glob.globSync([
    path.join(intermediate, '**/*@(.js|.js.map|.d.ts|.d.ts.map|.tsbuildinfo)'),
    path.join(intermediate, '**/@(.jsii|.jsii.gz|.jsii.tabl.*)'),
  ]);
  const exceptions = new Set([
    // Need to keep some declarations files that are part of the source...
    path.join(intermediate, 'custom-resources/lib/provider-framework/types.d.ts'),
  ]);
  for (const artifact of artifacts) {
    if (exceptions.has(artifact)) {
      continue;
    }
    fs.rmSync(artifact, { force: true, recursive: true });
  }

  // Remove @aws-cdk/* deps from package.json so we can npm install to get hoisted dependencies
  // into local node_modules
  const packageJsonPath = path.resolve(intermediate, 'package.json');
  const { devDependencies, ...pkgJson } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  const newDevDependencies = Object.entries(devDependencies).reduce(
    (accum, [pkg, version]) => {
      if (pkg !== 'typescript' && !pkg.startsWith('@aws-cdk/')) {
        accum[pkg] = version as string;
      }
      return accum;
    },
    {
      // Un-modeled devDeps of `aws-cdk-lib` (if modeled, they will be overridden)
      '@types/aws-lambda': '*',
      '@types/fs-extra': '9.x',
      '@types/minimatch': '3.x',
      '@types/node': '14.x',
      '@types/punycode': '2.x',
      '@types/semver': '7.x',
      'aws-sdk': '2.x',
      'typescript': `${ts.versionMajorMinor}.x`,
      'typescript-json-schema': '*',
    } as Record<string, string>,
  );

  fs.writeFileSync(packageJsonPath, JSON.stringify({ ...pkgJson, devDependencies: newDevDependencies }, undefined, 2));

  // Run npm install to get package-lock.json for reproducible dependency tree
  assert.strictEqual(
    0,
    cp.spawnSync(npm, ['install'], { cwd: intermediate, stdio: ['ignore', 'inherit', 'inherit'] }).status,
  );
  fs.rmSync(path.resolve(intermediate, 'node_modules'), { force: true, recursive: true });
  tar.c(
    {
      file,
      cwd: intermediate,
      sync: true,
      gzip: true,
    },
    ['.'],
  );

  fs.rmSync(intermediate, { force: true, recursive: true });
  fs.rmSync(repoDir, { force: true, recursive: true });
}

// This file is being run as a script...
if (require.main === module) {
  const fixturesDir = path.join(__dirname, '..', 'fixtures', '.tarballs');
  fs.mkdirSync(fixturesDir, { recursive: true });

  fs.writeFileSync(path.join(fixturesDir, '.gitignore'), '!*.tgz\n');
  fs.writeFileSync(path.join(fixturesDir, '.gitattributes'), '*.tgz filter=lfs diff=lfs merge=lfs -text\n');

  const { ref } = yargs
    .scriptName('npx projen update-integ-package')
    .option('ref', {
      type: 'string',
      desc: 'The git ref to the aws/aws-cdk version to snapshot',
      default: 'v2-release',
    })
    .help()
    .parseSync();

  snapshotAwsCdk(ref, path.join(fixturesDir, 'aws-cdk-lib.tgz'));
}
