import { Match, RuleSet } from '../validator';

// A rule set defining all compilerOptions that are configurable via the jsii field in package.json
// This is an internal rule set, that may be used by other rule sets.
// We accept all value for these
const jsiiConfiguredOptions = new RuleSet();
jsiiConfiguredOptions.shouldPass('outdir', Match.ANY);
jsiiConfiguredOptions.shouldPass('rootDir', Match.ANY);
jsiiConfiguredOptions.shouldPass('forceConsistentCasingInFileNames', Match.ANY);
jsiiConfiguredOptions.shouldPass('declarationMap', Match.ANY);
jsiiConfiguredOptions.shouldPass('inlineSourceMap', Match.ANY);
jsiiConfiguredOptions.shouldPass('inlineSources', Match.ANY);
jsiiConfiguredOptions.shouldPass('sourceMap', Match.ANY);
jsiiConfiguredOptions.shouldPass('types', Match.ANY);
jsiiConfiguredOptions.shouldPass('baseUrl', Match.ANY);
jsiiConfiguredOptions.shouldPass('paths', Match.ANY);
jsiiConfiguredOptions.shouldPass('composite', Match.ANY); // configured via projectReferences
jsiiConfiguredOptions.shouldPass('tsBuildInfoFile', Match.ANY);

export default jsiiConfiguredOptions;
