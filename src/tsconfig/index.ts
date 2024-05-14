import * as ts from 'typescript';

export interface TypeScriptConfig {
  files?: string[];
  extends?: string | string[];
  include?: string[];
  exclude?: string[];
  references?: ts.ProjectReference[];
  compilerOptions: ts.CompilerOptions;
  watchOptions?: ts.WatchOptions;
  typeAcquisition?: ts.TypeAcquisition;
}

export enum TypeScriptConfigValidationRuleSet {
  STRICT = 'strict',
  GENERATED = 'generated',
  MINIMAL = 'minimal',
  NONE = 'off',
}
