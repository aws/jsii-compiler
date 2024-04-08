import { configurableViaJsiiSettings } from './generated';
import { jsiiIncompatibleOptions } from './minimal';
import { Match, RuleSet, RuleType } from '../validator';

// the rules for compiler options
const compilerOptions = new RuleSet({
  // in the strict ruleset we fail all options we do not have a rule for
  unexpectedFields: RuleType.FAIL,
});

// import all options that we allow to be configured for the generated file
compilerOptions.import(configurableViaJsiiSettings);

// import all options that are definitely incompatible
compilerOptions.import(jsiiIncompatibleOptions);

// Best practice rules
compilerOptions.pass('target', Match.eq('es2022')); // node18
compilerOptions.pass('lib', Match.arrEq(['es2022'])); // node18
compilerOptions.pass('module', Match.oneOf('node16', 'commonjs'));
compilerOptions.pass('strict', Match.eq(true));
compilerOptions.pass('incremental', Match.ANY);

// Deprecated ts options that should not be used with jsii
compilerOptions.pass('prepend', Match.MISSING);

export default compilerOptions;
