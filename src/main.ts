import '@jsii/check-node/run';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as util from 'node:util';
import chalk from 'chalk';
import * as log4js from 'log4js';
import { version as tsVersion } from 'typescript/package.json';
import * as yargs from 'yargs';

import { Compiler } from './compiler';
import { configureCategories, JsiiDiagnostic } from './jsii-diagnostic';
import { loadProjectInfo } from './project-info';
import { emitSupportPolicyInformation } from './support';
import { TypeScriptConfigValidationRuleSet } from './tsconfig';
import { formatRuleSet, RULE_SET_DESCRIPTIONS } from './tsconfig/rule-set-format';
import { validateTypeScriptConfigFile } from './tsconfig/tsconfig-validator';
import * as utils from './utils';
import { VERSION } from './version';
import { parseWarningCodes, silencedWarnings } from './warnings';

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
            alias: 'Wno',
            type: 'array',
            default: [],
            desc: 'List of warnings to silence. Accepts JSII codes (e.g. JSII5018), numbers (e.g. 5018), or diagnostic names (e.g. reserved-word, language-compatibility)',
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
            desc: 'Use this typescript configuration file to compile the jsii project.',
          })
          .conflicts('tsconfig', ['generate-tsconfig', 'project-references'])
          .option('validate-tsconfig', {
            group: OPTION_GROUP.TS,
            ...choiceWithDesc(
              RULE_SET_DESCRIPTIONS,
              'Validate the provided typescript configuration file against a set of rules.',
            ),
            defaultDescription: TypeScriptConfigValidationRuleSet.STRICT,
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
        try {
          _configureLog4js(argv.verbose);

          if (argv['generate-tsconfig'] != null && argv.tsconfig != null) {
            throw new utils.JsiiError('Options --generate-tsconfig and --tsconfig are mutually exclusive', true);
          }

          const projectRoot = path.normalize(path.resolve(process.cwd(), argv.PROJECT_ROOT));

          const { projectInfo, diagnostics: projectInfoDiagnostics } = loadProjectInfo(projectRoot);

          // disable all silenced warnings
          for (const key of argv['silence-warnings']) {
            for (const code of parseWarningCodes(String(key))) {
              silencedWarnings.add(code);
            }
          }

          configureCategories(projectInfo.diagnostics ?? {});

          const typeScriptConfig = argv.tsconfig ?? projectInfo.packageJson.jsii?.tsconfig;
          const validateTypeScriptConfig =
            (argv['validate-tsconfig'] as TypeScriptConfigValidationRuleSet) ??
            projectInfo.packageJson.jsii?.validateTsconfig ??
            TypeScriptConfigValidationRuleSet.STRICT;

          const compiler = new Compiler({
            projectInfo,
            projectReferences: argv['project-references'],
            failOnWarnings: argv['fail-on-warnings'],
            stripDeprecated: argv['strip-deprecated'] != null,
            stripDeprecatedAllowListFile: argv['strip-deprecated'],
            addDeprecationWarnings: argv['add-deprecation-warnings'],
            generateTypeScriptConfig: argv['generate-tsconfig'],
            typeScriptConfig,
            validateTypeScriptConfig,
            compressAssembly: argv['compress-assembly'],
          });

          const startTime = Date.now();
          const emitResult = argv.watch ? await compiler.watch() : compiler.emit();

          const allDiagnostics = [...projectInfoDiagnostics, ...emitResult.diagnostics];

          for (const diagnostic of allDiagnostics) {
            utils.logDiagnostic(diagnostic, projectRoot);
          }

          console.log(utils.formatCompilationSummary(allDiagnostics, emitResult.emitSkipped, Date.now() - startTime));

          if (emitResult.emitSkipped) {
            process.exitCode = 1;
          }
        } catch (e: unknown) {
          if (e instanceof utils.JsiiError) {
            if (e.showHelp) {
              console.log();
              yargs.showHelp();
              console.log();
            }

            const LOG = log4js.getLogger(utils.CLI_LOGGER);
            LOG.error(e.message);

            process.exitCode = -1;
          } else {
            throw e;
          }
        }
      },
    )
    .command(
      'validate-tsconfig [TSCONFIG]',
      'Validate a TypeScript configuration file against a jsii rule set, without compiling',
      (cmd) =>
        cmd
          .positional('TSCONFIG', {
            type: 'string',
            desc: 'The TypeScript configuration file to validate',
            defaultDescription: 'jsii.tsconfig from package.json, or tsconfig.json',
            normalize: true,
          })
          .option('rule-set', {
            group: OPTION_GROUP.TS,
            alias: 'R',
            ...choiceWithDesc(RULE_SET_DESCRIPTIONS, 'The rule set to validate the configuration file against.'),
            defaultDescription: TypeScriptConfigValidationRuleSet.STRICT,
          }),
      (argv) => {
        try {
          const verbosity = typeof argv.verbose === 'number' ? argv.verbose : 0;
          _configureLog4js(verbosity);

          // Read package.json config only when needed (tsconfig or rule-set not explicitly provided)
          const jsiiConfig =
            argv.TSCONFIG == null || argv['rule-set'] == null ? _readJsiiConfig(process.cwd()) : undefined;

          const tsconfigFile = argv.TSCONFIG ?? jsiiConfig?.tsconfig ?? 'tsconfig.json';
          const configPath = path.resolve(process.cwd(), tsconfigFile);
          const projectRoot = path.dirname(configPath);
          const configName = path.relative(projectRoot, configPath);
          const ruleSet = (argv['rule-set'] ??
            jsiiConfig?.validateTsconfig ??
            TypeScriptConfigValidationRuleSet.STRICT) as TypeScriptConfigValidationRuleSet;

          // Validation is disabled for the "off" rule set; mirror the compiler behavior.
          if (ruleSet === TypeScriptConfigValidationRuleSet.NONE) {
            utils.logDiagnostic(
              JsiiDiagnostic.JSII_4009_DISABLED_TSCONFIG_VALIDATION.create(undefined, configName),
              projectRoot,
            );
            return;
          }

          const violations = validateTypeScriptConfigFile(configPath, ruleSet);
          if (violations.length > 0) {
            utils.logDiagnostic(
              JsiiDiagnostic.JSII_4000_FAILED_TSCONFIG_VALIDATION.create(undefined, configName, ruleSet, violations),
              projectRoot,
            );
            process.exitCode = 1;
          } else {
            console.log(`✨ "${configName}" is valid against rule set "${ruleSet}"`);
          }
        } catch (e: unknown) {
          if (e instanceof utils.JsiiError) {
            const LOG = log4js.getLogger(utils.CLI_LOGGER);
            LOG.error(e.message);
            process.exitCode = -1;
          } else {
            throw e;
          }
        }
      },
    )
    .command(
      'rules [RULE_SET]',
      'Print the tsconfig validation rules for a rule set (or for all rule sets)',
      (cmd) =>
        cmd.positional('RULE_SET', {
          ...choiceWithDesc(RULE_SET_DESCRIPTIONS, 'The rule set to print. If omitted, all rule sets are printed.'),
        }),
      (argv) => {
        const selected = argv.RULE_SET as TypeScriptConfigValidationRuleSet | undefined;
        const sets =
          selected != null
            ? [selected]
            : (Object.values(TypeScriptConfigValidationRuleSet) as TypeScriptConfigValidationRuleSet[]);

        console.log(`${sets.map(formatRuleSet).join(`\n\n${chalk.dim('─'.repeat(72))}\n\n`)}\n`);
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
      [utils.CLI_LOGGER]: {
        type: 'stderr',
        layout: {
          type: 'pattern',
          pattern: stdoutColor ? '%[[%p]%] %m' : '[%p] %m',
        },
      },
    },
    categories: {
      default: { appenders: ['console'], level: _logLevel() },
      [utils.CLI_LOGGER]: {
        appenders: [utils.CLI_LOGGER],
        level: _logLevel(),
      },
      // The diagnostics logger must be set to INFO or more verbose, or watch won't show important messages
      [utils.DIAGNOSTICS]: {
        appenders: [utils.DIAGNOSTICS],
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

function _readJsiiConfig(dir: string): { tsconfig?: string; validateTsconfig?: string } | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    return pkg.jsii;
  } catch {
    return undefined;
  }
}
