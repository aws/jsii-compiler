import '@jsii/check-node/run';

import * as path from 'node:path';
import * as util from 'node:util';
import * as log4js from 'log4js';
import { version as tsVersion } from 'typescript/package.json';
import * as yargs from 'yargs';

import { Compiler } from './compiler';
import { configureCategories } from './jsii-diagnostic';
import { loadProjectInfo } from './project-info';
import { emitSupportPolicyInformation } from './support';
import { TypeScriptConfigValidationRuleSet } from './tsconfig';
import * as utils from './utils';
import { VERSION } from './version';
import { enabledWarnings } from './warnings';

const warningTypes = Object.keys(enabledWarnings);

function choiceWithDesc(
  choices: { [choice: string]: string },
  desc: string,
): {
  choices: string[];
  desc: string;
} {
  return {
    choices: Object.keys(choices),
    desc: [desc, ...Object.entries(choices).map(([choice, docs]) => `${choice}: ${docs}`)].join('\n'),
  };
}

enum OPTION_GROUP {
  JSII = 'jsii compiler options:',
  TS = 'TypeScript config options:',
}

const ruleSets: {
  [choice in TypeScriptConfigValidationRuleSet]: string;
} = {
  [TypeScriptConfigValidationRuleSet.STRICT]:
    'Validates the provided config against a strict rule set designed for maximum backwards-compatibility.',
  [TypeScriptConfigValidationRuleSet.GENERATED]:
    'Enforces a config as created by --generate-tsconfig. Use this to stay compatible with the generated config, but have full ownership over the file.',
  [TypeScriptConfigValidationRuleSet.MINIMAL]:
    'Only enforce options that are known to be incompatible with jsii. This rule set is likely to be incomplete and new rules will be added without notice as incompatibilities emerge.',
  [TypeScriptConfigValidationRuleSet.NONE]:
    'Disables all config validation, including options that are known to be incompatible with jsii. Intended for experimentation only. Use at your own risk.',
};

(async () => {
  await emitSupportPolicyInformation();

  await yargs
    .env('JSII')
    .command(
      ['$0 [PROJECT_ROOT]', 'compile [PROJECT_ROOT]'],
      'Compiles a jsii/TypeScript project',
      (argv) =>
        argv
          .positional('PROJECT_ROOT', {
            type: 'string',
            desc: 'The root of the project to be compiled',
            default: '.',
            normalize: true,
          })
          .option('watch', {
            alias: 'w',
            type: 'boolean',
            desc: 'Watch for file changes and recompile automatically',
          })
          .option('project-references', {
            group: OPTION_GROUP.JSII,
            alias: 'r',
            type: 'boolean',
            desc: 'Generate TypeScript project references (also [package.json].jsii.projectReferences)\nHas no effect if --tsconfig is provided',
          })
          .option('fix-peer-dependencies', {
            type: 'boolean',
            default: true,
            desc: 'This option no longer has any effect.',
            hidden: true,
          })
          .options('fail-on-warnings', {
            group: OPTION_GROUP.JSII,
            alias: 'Werr',
            type: 'boolean',
            desc: 'Treat warnings as errors',
          })
          .option('silence-warnings', {
            group: OPTION_GROUP.JSII,
            type: 'array',
            default: [],
            desc: `List of warnings to silence (warnings: ${warningTypes.join(',')})`,
          })
          .option('strip-deprecated', {
            group: OPTION_GROUP.JSII,
            type: 'string',
            desc: '[EXPERIMENTAL] Hides all @deprecated members from the API (implementations remain). If an optional file name is given, only FQNs present in the file will be stripped.',
          })
          .option('add-deprecation-warnings', {
            group: OPTION_GROUP.JSII,
            type: 'boolean',
            default: false,
            desc: '[EXPERIMENTAL] Injects warning statements for all deprecated elements, to be printed at runtime',
          })
          .option('generate-tsconfig', {
            group: OPTION_GROUP.TS,
            type: 'string',
            defaultDescription: 'tsconfig.json',
            desc: 'Name of the typescript configuration file to generate with compiler settings',
          })
          .option('tsconfig', {
            group: OPTION_GROUP.TS,
            alias: 'c',
            type: 'string',
            desc: '[EXPERIMENTAL] Use this typescript configuration file to compile the jsii project.',
          })
          .conflicts('tsconfig', ['generate-tsconfig', 'project-references'])
          .option('validate-tsconfig', {
            group: OPTION_GROUP.TS,
            ...choiceWithDesc(
              ruleSets,
              '[EXPERIMENTAL] Validate the provided typescript configuration file against a set of rules.',
            ),
            default: TypeScriptConfigValidationRuleSet.STRICT,
          })
          .option('compress-assembly', {
            group: OPTION_GROUP.JSII,
            type: 'boolean',
            default: false,
            desc: 'Emit a compressed version of the assembly',
          })
          .option('verbose', {
            alias: 'v',
            type: 'count',
            desc: 'Increase the verbosity of output',
            global: true,
          }),
      async (argv) => {
        _configureLog4js(argv.verbose);

        if (argv['generate-tsconfig'] != null && argv.tsconfig != null) {
          throw new Error('Options --generate-tsconfig and --tsconfig are mutually exclusive');
        }

        const projectRoot = path.normalize(path.resolve(process.cwd(), argv.PROJECT_ROOT));

        const { projectInfo, diagnostics: projectInfoDiagnostics } = loadProjectInfo(projectRoot);

        // disable all silenced warnings
        for (const key of argv['silence-warnings']) {
          if (!(key in enabledWarnings)) {
            throw new Error(`Unknown warning type ${key as any}. Must be one of: ${warningTypes.join(', ')}`);
          }

          enabledWarnings[key] = false;
        }

        configureCategories(projectInfo.diagnostics ?? {});

        const compiler = new Compiler({
          projectInfo,
          projectReferences: argv['project-references'],
          failOnWarnings: argv['fail-on-warnings'],
          stripDeprecated: argv['strip-deprecated'] != null,
          stripDeprecatedAllowListFile: argv['strip-deprecated'],
          addDeprecationWarnings: argv['add-deprecation-warnings'],
          generateTypeScriptConfig: argv['generate-tsconfig'],
          typeScriptConfig: argv.tsconfig ?? projectInfo.packageJson.jsii?.tsconfig,
          validateTypeScriptConfig:
            (argv['validate-tsconfig'] as TypeScriptConfigValidationRuleSet) ??
            projectInfo.packageJson.jsii?.validateTsConfig,
          compressAssembly: argv['compress-assembly'],
        });

        const emitResult = argv.watch ? await compiler.watch() : compiler.emit();

        const allDiagnostics = [...projectInfoDiagnostics, ...emitResult.diagnostics];

        for (const diagnostic of allDiagnostics) {
          utils.logDiagnostic(diagnostic, projectRoot);
        }
        if (emitResult.emitSkipped) {
          process.exitCode = 1;
        }
      },
    )
    .help()
    .version(`${VERSION}, typescript ${tsVersion}`)
    .parse();
})().catch((e) => {
  console.error(`Error: ${e.stack}`);
  process.exitCode = -1;
});

function _configureLog4js(verbosity: number) {
  const stderrColor = !!process.stderr.isTTY;
  const stdoutColor = !!process.stdout.isTTY;

  log4js.addLayout('passThroughNoColor', () => {
    return (loggingEvent) => utils.stripAnsi(util.format(...loggingEvent.data));
  });

  log4js.configure({
    appenders: {
      console: {
        type: 'stderr',
        layout: { type: stderrColor ? 'colored' : 'basic' },
      },
      [utils.DIAGNOSTICS]: {
        type: 'stdout',
        layout: {
          type: stdoutColor ? 'messagePassThrough' : ('passThroughNoColor' as any),
        },
      },
    },
    categories: {
      default: { appenders: ['console'], level: _logLevel() },
      // The diagnostics logger must be set to INFO or more verbose, or watch won't show important messages
      [utils.DIAGNOSTICS]: {
        appenders: ['diagnostics'],
        level: _logLevel(Math.max(verbosity, 1)),
      },
    },
  });

  function _logLevel(verbosityLevel = verbosity): keyof log4js.Levels {
    switch (verbosityLevel) {
      case 0:
        return 'WARN';
      case 1:
        return 'INFO';
      case 2:
        return 'DEBUG';
      case 3:
        return 'TRACE';
      default:
        return 'ALL';
    }
  }
}
