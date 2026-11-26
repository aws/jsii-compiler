import configurableOptions from './configurable-options';
import deprecatedOptions from './deprecated-options';
import incompatibleOptions from './incompatible-options';
import strictFamilyOptions from './strict-family-options';
import { Match, RuleSet, RuleType } from '../validator';

// The public rule set used for the "strict" tsconfig validation setting.
// The goal of this rule set is to ensure a tsconfig that is following best practices for jsii.
// In practice, this is a combination of known incompatible options, known configurable options and additional best practices.
// The rule set also explicitly disallows unknown options.
const strict = new RuleSet({
  unexpectedFields: RuleType.FAIL,
});

// import all options that are configurable
strict.import(configurableOptions);

// import all options that are definitely incompatible
strict.import(incompatibleOptions);

// strict family options
strict.import(strictFamilyOptions);

// Best practice rules
strict.shouldPass('target', Match.oneOf('es2022', 'es2023', 'esnext')); // node18+
strict.shouldPass('lib', Match.anyOf(Match.arrEq(['es2022']), Match.arrEq(['es2023']), Match.arrEq(['esnext']))); // node18+
strict.shouldPass('module', Match.oneOf('node16', 'node18', 'node20', 'nodenext', 'commonjs'));
strict.shouldPass('moduleResolution', Match.optional(Match.oneOf('node16', 'nodenext', 'bundler')));
strict.shouldPass('skipLibCheck', Match.TRUE);
strict.shouldPass('stripInternal', Match.optional(Match.FALSE));
strict.shouldPass('noEmitOnError', Match.TRUE);
strict.shouldPass('declaration', Match.TRUE);
strict.shouldPass('noUncheckedSideEffectImports', Match.optional(Match.TRUE));

// Deprecated ts options that should not be used with jsii
strict.import(deprecatedOptions);

export default strict;
