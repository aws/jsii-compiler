import { Match, RuleSet } from '../validator';

// A rule set for deprecated compilerOptions that should not be used with jsii.
// These options are deprecated in TypeScript 6.0 and will be removed in TypeScript 7.0.
// This is an internal rule set, that may be used by other rule sets.
const deprecatedOptions = new RuleSet();
deprecatedOptions.shouldPass('prepend', Match.MISSING);
deprecatedOptions.shouldPass('downlevelIteration', Match.MISSING);
deprecatedOptions.shouldPass('outFile', Match.MISSING);
deprecatedOptions.shouldPass('baseUrl', Match.MISSING);

// esModuleInterop: false and allowSyntheticDefaultImports: false are deprecated
deprecatedOptions.shouldPass('esModuleInterop', Match.optional(Match.TRUE));
deprecatedOptions.shouldPass('allowSyntheticDefaultImports', Match.optional(Match.TRUE));

// alwaysStrict: false is deprecated
deprecatedOptions.shouldPass('alwaysStrict', Match.optional(Match.TRUE));

// target: es5 is deprecated
deprecatedOptions.shouldFail('target', Match.eq('es5'));

// Deprecated module values: amd, umd, systemjs, none
deprecatedOptions.shouldFail('module', Match.oneOf('amd', 'umd', 'systemjs', 'none'));

// Deprecated moduleResolution values: node (node10), classic
deprecatedOptions.shouldFail('moduleResolution', Match.oneOf('node', 'node10', 'classic'));

export default deprecatedOptions;
