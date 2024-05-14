import configurable from './configurable';
import incompatible from './incompatible-options';
import { Match, RuleSet, RuleType } from '../validator';

// The public rule set used for the "strict" tsconfig validation setting.
// The goal of this rule set is to ensure a tsconfig that is following best practices for jsii.
// In practice, this is a combination of known incompatible options, known configurable options and additional best practices.
// The rule set also explicitly disallows unknown options.
const strict = new RuleSet({
  unexpectedFields: RuleType.FAIL,
});

// import all options that are configurable
strict.import(configurable);

// import all options that are definitely incompatible
strict.import(incompatible);

// Best practice rules
strict.shouldPass('target', Match.eq('es2022')); // node18
strict.shouldPass('lib', Match.arrEq(['es2022'])); // node18
strict.shouldPass('module', Match.oneOf('node16', 'commonjs'));
strict.shouldPass('moduleResolution', Match.optional(Match.oneOf('node', 'node16')));
strict.shouldPass('esModuleInterop', Match.TRUE);
strict.shouldPass('skipLibCheck', Match.TRUE);
strict.shouldPass('strict', Match.eq(true));
strict.shouldPass('incremental', Match.ANY);

// Deprecated ts options that should not be used with jsii
strict.shouldPass('prepend', Match.MISSING);

export default strict;
