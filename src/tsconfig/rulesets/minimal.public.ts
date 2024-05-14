import incompatible from './incompatible-options';
import { RuleSet } from '../validator';

// The public rule set used for the "minimal" tsconfig validation setting
// To goal of this rule set is to only prevent obvious misconfigurations,
// while leaving everything else up to the user.
const minimal = new RuleSet();
minimal.import(incompatible);

export default minimal;
