/**
 * The JSON form of TypeScript `compilerOptions`, as written in a `tsconfig.json`
 * file (enum-like options are strings such as `"node20"` or `"es2023"`).
 *
 * The compiler never materializes the in-process `ts.CompilerOptions` object
 * anymore: configuration is produced and consumed in its file form, and the
 * TypeScript 7 server parses it.
 */
export type CompilerOptionsJson = { [option: string]: unknown };

export interface ProjectReferenceJson {
  path: string;
  prepend?: boolean;
  circular?: boolean;
}

export interface TypeScriptConfig {
  files?: string[];
  extends?: string | string[];
  include?: string[];
  exclude?: string[];
  references?: ProjectReferenceJson[];
  compilerOptions: CompilerOptionsJson;
  watchOptions?: { [option: string]: unknown };
  typeAcquisition?: { [option: string]: unknown };
}

export enum TypeScriptConfigValidationRuleSet {
  STRICT = 'strict',
  GENERATED = 'generated',
  MINIMAL = 'minimal',
  NONE = 'off',
}
