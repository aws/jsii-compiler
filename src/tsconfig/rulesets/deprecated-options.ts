import { Match, RuleSet } from '../validator';

// A rule set for deprecated compilerOptions that should not be used with jsii
// This is an internal rule set, that may be used by other rule sets.
const deprecatedOptions = new RuleSet();
deprecatedOptions.shouldPass('prepend', Match.MISSING);

export default deprecatedOptions;
