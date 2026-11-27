import incompatibleOptions from './incompatible-options';
import { Match, RuleSet } from '../validator';

// The public rule set used for the "minimal" tsconfig validation setting
// To goal of this rule set is to only prevent obvious misconfigurations,
// while leaving everything else up to the user.
const minimal = new RuleSet();
minimal.import(incompatibleOptions);

// jsii needs declarations. tsc also emits them for composite projects,
// so `composite: true` is accepted when `declaration` is not set.
minimal.shouldPass(
  'declaration',
  (value, options) => Match.TRUE(value, options) || Match.TRUE(options?.data?.composite),
);

export default minimal;
