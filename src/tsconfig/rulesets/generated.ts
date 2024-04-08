import { BASE_COMPILER_OPTIONS, convertForJson } from '../compiler-options';
import { Match, RuleSet, RuleType } from '../validator';

// legacy settings configurable via jsii
// we accept all value for these
export const configurableViaJsiiSettings = new RuleSet();
configurableViaJsiiSettings.pass('outdir', Match.ANY);
configurableViaJsiiSettings.pass('rootDir', Match.ANY);
configurableViaJsiiSettings.pass('forceConsistentCasingInFileNames', Match.ANY);
configurableViaJsiiSettings.pass('declarationMap', Match.ANY);
configurableViaJsiiSettings.pass('inlineSourceMap', Match.ANY);
configurableViaJsiiSettings.pass('inlineSources', Match.ANY);
configurableViaJsiiSettings.pass('sourceMap', Match.ANY);
configurableViaJsiiSettings.pass('types', Match.ANY);
configurableViaJsiiSettings.pass('baseUrl', Match.ANY);
configurableViaJsiiSettings.pass('paths', Match.ANY);
configurableViaJsiiSettings.pass('composite', Match.ANY); // configured via projectReferences
configurableViaJsiiSettings.pass('tsBuildInfoFile', Match.ANY);

// Create the rules for compiler options
const compilerOptions = new RuleSet({
  // we only allow explicitly checked fields
  unexpectedFields: RuleType.FAIL,
});

// Add allowed legacy options that are configurable via jsii settings
compilerOptions.import(configurableViaJsiiSettings);

// ... and all generated options
compilerOptions.passMany(convertForJson(BASE_COMPILER_OPTIONS));

export default compilerOptions;
