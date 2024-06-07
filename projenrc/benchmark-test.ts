import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { github, typescript } from 'projen';
import { JobPermission } from 'projen/lib/github/workflows-model';
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

    const iterations = 20;
    const indices = Array.from({ length: iterations }, (_, idx) => idx);

    wf.addJobs({
      benchmark: {
        env: { CI: 'true' },
        name: 'Benchmark (${{ matrix.compiler }}, run ${{ matrix.index }})',
        needs,
        outputs: Object.fromEntries(
          indices.flatMap((idx) => [
            [`jsii-${idx}`, { stepId: 'run', outputName: `jsii-${idx}` }],
            [`tsc-${idx}`, { stepId: 'run', outputName: `tsc-${idx}` }],
          ]),
        ),
        permissions: { contents: github.workflows.JobPermission.READ },
        runsOn: ['ubuntu-latest'],
        strategy: {
          matrix: {
            domain: {
              compiler: ['jsii', 'tsc'],
              // Run each 20 times to average out disparities in timing...
              index: indices,
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
              'RESULT=$(yarn --silent projen test:benchmark --compiler=${{ matrix.compiler }})',
              'echo "${{ matrix.compiler }}-${{ matrix.index }}=${RESULT}" >> $GITHUB_OUTPUT',
            ].join('\n'),
          },
        ],
      },
      benchmark_summary: {
        env: { CI: 'true' },
        name: 'Benchmark',
        needs: ['benchmark'],
        // outputs: {
        //   'duration-jsii': {
        //     value: '${{ steps.duration-jsii.outputs.duration }}',
        //   },
        //   'duration-tsc': {
        //     description: 'Duration of tsc benchmark',
        //     value: '${{ steps.duration-tsc.outputs.duration }}',
        //   },
        // },
        // }
        // Object.fromEntries(
        //   indices.flatMap((idx) => [
        //     [`duration-jsii`, { stepId: 'run', outputName: `jsii-${idx}` }],
        //     [`duration-tsc`, { stepId: 'run', outputName: `tsc-${idx}` }],
        //   ]),
        // ),
        permissions: {
          idToken: JobPermission.WRITE,
        },
        runsOn: ['ubuntu-latest'],
        steps: [
          {
            name: 'Output Summary',
            id: 'output_summary',
            run: [
              'node <<"EOF"',
              'const fs = require("node:fs");',
              '',
              `const outputFilePath = process.env.GITHUB_OUTPUT;`,
              '',
              'const results = ${{ toJSON(needs.benchmark.outputs) }};',
              'console.debug(results);',
              '',
              'const stats = {};',
              'for (const [key, value] of Object.entries(results)) {',
              '  const [compiler,] = key.split("-");',
              '  stats[compiler] ??= [];',
              '  stats[compiler].push(JSON.parse(value).time);',
              '}',
              '',
              'for (const [compiler, values] of Object.entries(stats)) {',
              '  const avg = values.reduce((a, b) => a + b, 0) / values.length;',
              '  const variance = values.reduce((vari, elt) => ((elt - avg) ** 2) + vari, 0) / values.length;',
              '  stats[compiler] = {',
              '    min: Math.min(...values),',
              '    max: Math.max(...values),',
              '    avg,',
              '    stddev: Math.sqrt(variance),',
              '  };',
              '}',
              'const fastest = Object.values(stats).reduce((fast, { avg }) => Math.min(fast, avg), Infinity);',
              '',
              'const summary = [',
              '  "## Benchmark Results",',
              '  "",',
              '  "Compiler | Fastest | Avergae | Slowest | StdDev | Slowdown",',
              '  "---------|--------:|--------:|--------:|-------:|--------:",',
              '];',
              'const ms = new Intl.NumberFormat("en-US", { style: "unit", unit: "millisecond", maximumFractionDigits: 1, minimumFractionDigits: 1 });',
              'const dec = new Intl.NumberFormat("en-US", { style: "decimal", maximumFractionDigits: 1, minimumFractionDigits: 1 });',
              'const pre = (s) => `\\`${s}\\``;',
              'for (const [compiler, { min, max, avg, stddev }] of Object.entries(stats).sort(([, l], [, r]) => l.avg - r.avg)) {',
              '  summary.push([compiler, pre(ms.format(min)), pre(ms.format(avg)), pre(ms.format(max)), pre(dec.format(stddev)), pre(`${dec.format(avg / fastest)}x`)].join(" | "));',
              `  const key = 'duration-' + compiler;`,
              `  const value = avg;`,
              '',
              '  fs.appendFileSync(outputFilePath, `${key}=${value}\n`)',
              '}',
              'summary.push("");',
              '',
              'fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\\n"), "utf-8");',
              'EOF',
            ].join('\n'),
          },
          {
            name: 'Authenticate Via OIDC Role',
            uses: 'aws-actions/configure-aws-credentials@v4',
            with: {
              'aws-region': 'us-east-1',
              'role-duration-seconds': 900,
              'role-to-assume': 'arn:aws:iam::590183883712:role/Ops-jsiiTeamOIDC-Role1ABCC5F0-jL37v7e7I15P',
              'role-session-name': 'github-diff-action@cdk-ops',
              'output-credentials': true,
            },
          },
          {
            name: 'Publish Metrics',
            run: [
              'aws cloudwatch put-metric-data --metric-name tsc-benchmark-time-test --namespace JsiiPerformance --value ${{ steps.output_summary.outputs.duration-tsc }}',
              'aws cloudwatch put-metric-data --metric-name jsii-benchmark-time-test --namespace JsiiPerformance --value ${{ steps.output_summary.outputs.duration-jsii }}',
            ].join('\n'),
          },
        ],
      },
      // benchmark_metrics: {
      //   env: { CI: 'true' },
      //   name: 'Publich Benchmark Metrics',
      //   needs: ['benchmark_summary'],
      //   permissions: {
      //     idToken: JobPermission.WRITE,
      //   },
      //   runsOn: ['ubuntu-latest'],
      //   steps: [
      //     {
      //       name: 'Authenticate Via OIDC Role',
      //       uses: 'aws-actions/configure-aws-credentials@v4',
      //       with: {
      //         'aws-region': 'us-east-1',
      //         'role-duration-seconds': 900,
      //         'role-to-assume': 'arn:aws:iam::590183883712:role/Ops-jsiiTeamOIDC-Role1ABCC5F0-jL37v7e7I15P',
      //         'role-session-name': 'github-diff-action@cdk-ops',
      //         'output-credentials': true,
      //       },
      //     },
      //     {
      //       name: 'Publish Metrics',
      //       run: [
      //         'aws cloudwatch put-metric-data --metric-name tsc-benchmark-time-test --namespace JsiiPerformance --value ${{ needs.benchmark_summary.outputs.test-duration-tsc }}',
      //         'aws cloudwatch put-metric-data --metric-name jsii-benchmark-time-test --namespace JsiiPerformance --value ${{ needs.benchmark_summary.outputs.test-duration-jsii }}',
      //       ].join('\n'),
      //     },
      //   ],
      // },
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
              return [require.resolve('typescript/bin/tsc'), '--build', tsconfig];
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
