import { Match, RuleSet } from '../validator';

// A rule set for the compilerOptions of the strict family.
// The rule set enforces strict, but allows the defining options that are implied by strict

const strictFamilyOptions = new RuleSet();
strictFamilyOptions.shouldPass('strict', Match.eq(true));
strictFamilyOptions.shouldPass('alwaysStrict', Match.optional(Match.eq(true)));
strictFamilyOptions.shouldPass('noImplicitAny', Match.optional(Match.eq(true)));
strictFamilyOptions.shouldPass('noImplicitThis', Match.optional(Match.eq(true)));
strictFamilyOptions.shouldPass('strictBindCallApply', Match.optional(Match.eq(true)));
strictFamilyOptions.shouldPass('strictFunctionTypes', Match.optional(Match.eq(true)));
strictFamilyOptions.shouldPass('strictNullChecks', Match.optional(Match.eq(true)));
strictFamilyOptions.shouldPass('strictPropertyInitialization', Match.optional(Match.eq(true)));
strictFamilyOptions.shouldPass('useUnknownInCatchVariables', Match.optional(Match.eq(true)));

export default strictFamilyOptions;
