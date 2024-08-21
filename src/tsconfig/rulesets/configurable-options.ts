import jsiiConfiguredOptions from './jsii-configured-options';
import { Match, RuleSet } from '../validator';

// A rule set defining all compilerOptions that can be configured by users with or without constraints.
// These are options jsii doesn't have a particular opinion about
// This is an internal rule set, that may be used by other rule sets.

const configurableOptions = new RuleSet();

// import all options that are configurable via jsii settings
configurableOptions.import(jsiiConfiguredOptions);

// options jsii allows to be configured
configurableOptions.shouldPass('incremental', Match.ANY);
configurableOptions.shouldPass('noImplicitReturns', Match.ANY);
configurableOptions.shouldPass('noUnusedLocals', Match.ANY);
configurableOptions.shouldPass('noUnusedParameters', Match.ANY);
configurableOptions.shouldPass('resolveJsonModule', Match.ANY);
configurableOptions.shouldPass('experimentalDecorators', Match.ANY);
configurableOptions.shouldPass('noFallthroughCasesInSwitch', Match.ANY);
configurableOptions.shouldPass('verbatimModuleSyntax', Match.ANY);
configurableOptions.shouldPass('isolatedModules', Match.ANY);

export default configurableOptions;
