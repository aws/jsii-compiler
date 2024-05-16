import { Match, RuleSet } from '../validator';

// A rule set defining all compilerOptions that can be configured by users with or without constraints.
// This is an internal rule set, that may be used by other rule sets.

// Settings previously configurable via the jsii field in package.json
// We accept all value for these
const configurable = new RuleSet();
configurable.shouldPass('outdir', Match.ANY);
configurable.shouldPass('rootDir', Match.ANY);
configurable.shouldPass('forceConsistentCasingInFileNames', Match.ANY);
configurable.shouldPass('declarationMap', Match.ANY);
configurable.shouldPass('inlineSourceMap', Match.ANY);
configurable.shouldPass('inlineSources', Match.ANY);
configurable.shouldPass('sourceMap', Match.ANY);
configurable.shouldPass('types', Match.ANY);
configurable.shouldPass('baseUrl', Match.ANY);
configurable.shouldPass('paths', Match.ANY);
configurable.shouldPass('composite', Match.ANY); // configured via projectReferences
configurable.shouldPass('tsBuildInfoFile', Match.ANY);

export default configurable;
