import { RuleSet } from '../validator';

// A rule set for compilerOptions and values that TypeScript has deprecated. They should not be used with jsii.
// Once TypeScript removes an option, it rejects it on its own and the rule can be removed from here.
// This is an internal rule set, that may be used by other rule sets.
const deprecatedOptions = new RuleSet();

export default deprecatedOptions;
