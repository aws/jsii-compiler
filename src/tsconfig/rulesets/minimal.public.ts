import incompatibleOptions from './incompatible-options';
import { Match, RuleSet } from '../validator';

// The public rule set used for the "minimal" tsconfig validation setting
// To goal of this rule set is to only prevent obvious misconfigurations,
// while leaving everything else up to the user.
const minimal = new RuleSet();
minimal.import(incompatibleOptions);

// jsii needs declarations. Like strict, require `declaration` explicitly,
// even though tsc also emits them for composite projects.
minimal.shouldPass('declaration', Match.TRUE);

export default minimal;
