import { Match, RuleSet } from '../validator';

// A rule set defining all compilerOptions that are explicitly known to be incompatible with jsii
// This is an internal rule set, that may be used by other rule sets.
const incompatibleOptions = new RuleSet();
incompatibleOptions.shouldFail('noEmit', Match.TRUE);
incompatibleOptions.shouldFail('noLib', Match.TRUE);
incompatibleOptions.shouldFail('declaration', Match.FALSE);
incompatibleOptions.shouldFail('emitDeclarationOnly', Match.TRUE);

export default incompatibleOptions;
