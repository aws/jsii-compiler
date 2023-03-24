import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { github, typescript } from 'projen';
import * as tar from 'tar';
import * as ts from 'typescript';
import * as yargs from 'yargs';
import { ACTIONS_SETUP_NODE, YARN_INSTALL } from './common';

export class BenchmarkTest {
  public constructor(
    project: typescript.TypeScriptProject,
    wf: github.GithubWorkflow,
    { needs, artifactName }: { readonly artifactName: string; readonly needs: string[] },
  ) {
    project.addTask('test:benchmark', {
      description: 'Executes the benchmark test',
      exec: 'ts-node ./projenrc/benchmark-test.ts',
      receiveArgs: true,
    });

    wf.addJobs({
      benchmark: {
        env: { CI: 'true' },
        name: 'Benchmark (${{ matrix.compiler }})',
        needs,
        outputs: {
          jsii: {
            stepId: 'run',
            outputName: 'jsii',
          },
          tsc: {
            stepId: 'run',
            outputName: 'tsc',
          },
        },
        permissions: { contents: github.workflows.JobPermission.READ },
        runsOn: ['ubuntu-latest'],
        strategy: {
          matrix: {
            domain: {
              compiler: ['jsii', 'tsc'],
            },
          },
        },
        steps: [
          ACTIONS_SETUP_NODE(undefined, false),
          {
            name: 'Download artifact',
            uses: 'actions/download-artifact@v3',
            with: { name: artifactName },
          },
          YARN_INSTALL('--check-files'),
          {
            id: 'run',
            name: 'Benchmark',
            run: [
              'set -x',
              'RESULT=$(yarn test:benchmark --compiler=${{ matrix.compiler }})',
              'echo "${{ matrix.compiler }}=${RESULT}" >> $GITHUB_OUTPUT',
            ].join('\n'),
          },
        ],
      },
      benchmark_summary: {
        env: { CI: 'true' },
        name: 'Benchmark Summary',
        needs: ['benchmark'],
        permissions: {},
        runsOn: ['ubuntu-latest'],
        steps: [
          {
            name: 'Output Summary',
            run: [
              'node <<(EOF)',
              'const results = {',
              '  jsii: ${{ needs.benchmark.outputs.jsii }},',
              '  tsc: ${{ needs.benchmark.outputs.tsc }},',
              '};',
              'const delta = (results.jsii.time - results.tsc.time) / results.tsc.time;',
              'console.log(`Time for jsii: ${results.jsii.time} ms`);',
              'console.log(`Time for tsc:  ${results.tsc.time} ms`);',
              'console.log(`Slowdown:      ${(100 * delta).toFixed(1)}%`);',
              'EOF',
            ].join('\n'),
          },
        ],
      },
    });
  }
}

if (require.main === module) {
  (async function () {
    const { compiler, silent } = await yargs
      .scriptName('yarn projen test:benchmark')
      .option('silent', {
        default: false,
        desc: 'Run silently, hiding sub-command outputs',
        type: 'boolean',
      })
      .option('compiler', {
        choices: ['tsc', 'jsii'],
        desc: 'The compiler to be used for benchmarking',
        demandOption: true,
        coerce: (value: string) => {
          switch (value) {
            case 'jsii':
            case 'tsc':
              return value;
            default:
              throw new Error(`Invalid compiler name: ${JSON.stringify(value)}`);
          }
        },
      })
      .help()
      .parseAsync();

    const workDir = mkdtempSync(join(tmpdir(), 'jsii-compiler-benchmark-'));
    try {
      // Extract the fixture tarball into the work directory
      await tar.x({
        file: join(__dirname, '..', 'fixtures', '.tarballs', 'aws-cdk-lib.tgz'),
        cwd: workDir,
      });

      await new Promise<void>((ok, ko) => {
        const child = spawn('yarn', ['install', '--frozen-lockfile'], {
          stdio: silent ? 'ignore' : ['ignore', process.stderr, process.stderr],
          cwd: workDir,
        });
        child.once('exit', (code, signal) => {
          if (code === 0) {
            return ok();
          }
          const reason = code != null ? `exit code ${code}` : `signal ${signal}`;
          ko(new Error(`jsii exited with ${reason}`));
        });
      });

      // Build with the selected compiler
      const time = await new Promise((ok, ko) => {
        const command = (function () {
          switch (compiler) {
            case 'jsii':
              return [require.resolve('../lib/main.js'), workDir, '--silence-warnings=reserved-word'];
            case 'tsc':
              const tsconfig = join(workDir, 'tsconfig.tsc.json');
              writeFileSync(
                tsconfig,
                JSON.stringify(
                  {
                    compilerOptions: {
                      alwaysStrict: true,
                      composite: false,
                      declaration: true,
                      declarationMap: false,
                      experimentalDecorators: true,
                      incremental: true,
                      inlineSourceMap: true,
                      inlineSources: true,
                      lib: ['es2020'],
                      module: 'CommonJS',
                      noEmitOnError: true,
                      noFallthroughCasesInSwitch: true,
                      noImplicitAny: true,
                      noImplicitReturns: true,
                      noImplicitThis: true,
                      noUnusedLocals: true,
                      noUnusedParameters: true,
                      resolveJsonModule: true,
                      skipLibCheck: true,
                      strictNullChecks: true,
                      strictPropertyInitialization: true,
                      stripInternal: false,
                      target: 'ES2020',
                      tsBuildInfoFile: 'tsconfig.tsbuildinfo',
                    } satisfies Serialized<ts.CompilerOptions>,
                    include: ['**/*.ts'],
                    exclude: ['node_modules', '.types-compat', 'build-tools/*'],
                  },
                  null,
                  2,
                ),
              );
              return [require.resolve('typescript/bin/tsc'), '--build', '--project', tsconfig];
          }
        })();

        const now = Date.now();
        const child = spawn(process.execPath, command, {
          env: {
            NODE_OPTIONS: '--max_old_space_size=4096',
          },
          stdio: silent ? 'ignore' : ['ignore', process.stderr, process.stderr],
        });
        child.once('exit', (code, signal) => {
          if (code === 0) {
            return ok(Date.now() - now);
          }
          const reason = code != null ? `exit code ${code}` : `signal ${signal}`;
          ko(new Error(`${compiler} exited with ${reason}`));
        });
      });

      console.log(JSON.stringify({ time }));
    } finally {
      rmSync(workDir, { force: true, recursive: true });
    }
  })().catch((cause) => {
    console.error(cause);
    process.exitCode = -1;
  });
}

type Serialized<T> = {
  [P in keyof T]: T[P] extends ts.ModuleKind | undefined
    ? undefined | keyof typeof ts.ModuleKind
    : T[P] extends ts.ScriptTarget | undefined
    ? undefined | keyof typeof ts.ScriptTarget
    : T[P];
};
