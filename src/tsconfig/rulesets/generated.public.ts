import jsiiConfiguredOptions from './jsii-configured-options';
import { BASE_COMPILER_OPTIONS, convertForJson } from '../compiler-options';
import { Match, RuleSet, RuleType } from '../validator';

// The public rule set used for the "generated" tsconfig validation setting.\
// The goal of this rule set is to ensure a tsconfig is compatible to the one jsii would generate for the user.
// It is explicitly enforcing option values that are used for the generated tsconfig,
// as well as options that can be configured via jsii settings. All other options are disallowed.
const generated = new RuleSet({
  unexpectedFields: RuleType.FAIL,
});

// import all options that are configurable via jsii settings
generated.import(jsiiConfiguredOptions);

// ... and all generated options
for (const [field, value] of Object.entries(convertForJson(BASE_COMPILER_OPTIONS))) {
  if (typeof value === 'string') {
    generated.shouldPass(field, Match.strEq(value, true));
    continue;
  }

  if (Array.isArray(value)) {
    generated.shouldPass(field, Match.arrEq(value));
    continue;
  }

  generated.shouldPass(field, Match.eq(value));
}

export default generated;
