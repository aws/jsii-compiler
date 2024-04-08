import * as ts from 'typescript';
import { RuleSet } from '../validator';

// CompilerOptions and values that are explicitly not supported
// If we include "foo: 'bar'" here,
// it would mean that validation fails if the option "foo" is exactly "bar"
// All other values for foo would be valid.
const INVALID_COMPILER_OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  declaration: false,
  noLib: true,
};

// in the minimal rule set we pass everything unless it is explicitly failed
export const jsiiIncompatibleOptions = new RuleSet();
jsiiIncompatibleOptions.failMany(INVALID_COMPILER_OPTIONS);

export default jsiiIncompatibleOptions;
