/*
 * ---------------------------------------------------------------------------
 * `--add-deprecation-warnings`: the `.warnings.jsii.js` file.
 *
 * Port of the classic `DeprecationWarningsInjector` (main:
 * src/transforms/deprecation-warnings.ts). The logic that decides which
 * validators exist and what they contain is the same, line for line. What
 * changed is only how the code is built and printed: the statements are made
 * with the TypeScript 7 AST factory (`#typescript/ast/factory`) and printed by
 * the TypeScript 7 printer (`api.printer.printNode`), which lays out code the
 * same way the TypeScript 6 printer did.
 *
 * Not here yet: the calls injected into the emitted `.js` (the classic
 * `Transformer`). TypeScript 7 has no transformer hook, so that becomes a
 * post-emit pass.
 * ---------------------------------------------------------------------------
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as spec from '@jsii/spec';
import { Assembly } from '@jsii/spec';

import { TypeScriptApi, TypeScriptProject } from '../compiler-host';
import { ProjectInfo } from '../project-info';

export const WARNINGSCODE_FILE_NAME = '.warnings.jsii.js';
const WARNING_FUNCTION_NAME = 'print';
const PARAMETER_NAME = 'p';
const FOR_LOOP_ITEM_NAME = 'o';
const VISITED_OBJECTS_SET_NAME = 'visitedObjects';
const DEPRECATION_ERROR = 'DeprecationError';
const GET_PROPERTY_DESCRIPTOR = 'getPropertyDescriptor';
const VALIDATORS_OBJ = 'VALIDATORS';

/**
 * Enum member declarations (TypeScript 7 node handles), by enum fqn and member
 * name. The constant value of a member is read from its declaration.
 */
export type EnumMemberDeclarations = ReadonlyMap<string, ReadonlyMap<string, any>>;

export class DeprecationWarningsInjector {
  private readonly f: any;
  private readonly k: any;
  private readonly nodeFlags: any;
  private shouldRenderValidatorCache: Record<string, boolean> = {};
  private validatorCacheSeenSet = new Set<string>();

  public constructor(
    ts: TypeScriptApi,
    private readonly project: TypeScriptProject,
    private readonly enumMembers: EnumMemberDeclarations,
  ) {
    this.f = ts.factory;
    this.k = ts.SyntaxKind;
    this.nodeFlags = ts.NodeFlags;
  }

  /**
   * Write `.warnings.jsii.js` to the project root.
   */
  public process(assembly: Assembly, projectInfo: ProjectInfo) {
    const f = this.f;
    const projectRoot = projectInfo.projectRoot;
    const validationFunctions: any[] = [];

    const types = assembly.types ?? {};
    for (const type of Object.values(types)) {
      const fnStatements = this.generateTypeValidation(type, assembly, projectInfo, types);
      if (fnStatements.length === 0) {
        continue;
      }

      const paramValue = f.createParameterDeclaration(undefined, undefined, this.id(PARAMETER_NAME));
      const functionName = fnName(type.fqn);
      const functionExpr = f.createFunctionExpression(
        undefined,
        undefined,
        this.id(functionName),
        undefined,
        [paramValue],
        undefined,
        this.createFunctionBlock(fnStatements),
      );
      validationFunctions.push(
        f.createPropertyAssignment(undefined, this.id(functionName), undefined, undefined, functionExpr),
      );
    }

    const validators = f.createVariableStatement(
      undefined,
      f.createVariableDeclarationList(
        [
          f.createVariableDeclaration(
            this.id(VALIDATORS_OBJ),
            undefined,
            undefined,
            f.createObjectLiteralExpression(validationFunctions),
          ),
        ],
        this.nodeFlags.Const,
      ),
    );

    const declarations = [this.project.api.printer.printNode(validators)];
    const content = declarations.concat(WARNINGS_FILE_RUNTIME).join('\n');
    fs.writeFileSync(path.join(projectRoot, WARNINGSCODE_FILE_NAME), content);
  }

  /**
   * Whether the validator for the given type should be rendered
   *
   * A validator should be rendered if:
   *
   * - It contains any deprecated members (base case).
   * - It references any other types whose validators should be rendered.
   * - It inherits from other types whose validators should be rendered.
   * - It references types that reference this type (recursive types).
   * - It references types from another assembly.
   *
   */
  private shouldRenderValidator(type: spec.Type, assembly: Assembly): boolean {
    if (this.shouldRenderValidatorCache[type.fqn] !== undefined) {
      return this.shouldRenderValidatorCache[type.fqn];
    }

    if (this.validatorCacheSeenSet.has(type.fqn)) {
      // To be safe we need to say this is true.
      return true;
    }
    if (!type.fqn.startsWith(`${assembly.name}.`)) {
      // Foreign type, always check
      return true;
    }
    this.validatorCacheSeenSet.add(type.fqn);

    this.shouldRenderValidatorCache[type.fqn] = calculate.call(this);
    this.validatorCacheSeenSet.delete(type.fqn);

    return this.shouldRenderValidatorCache[type.fqn];

    function calculate(this: DeprecationWarningsInjector): boolean {
      if (spec.isDeprecated(type)) {
        return true;
      }
      if (spec.isEnumType(type)) {
        return (type.members ?? []).some(spec.isDeprecated);
      }
      if (spec.isInterfaceType(type) && type.datatype) {
        for (const prop of type.properties ?? []) {
          if (spec.isDeprecated(prop)) {
            return true;
          }

          const typesToInspect = spec.isCollectionTypeReference(prop.type)
            ? [prop.type.collection.elementtype]
            : spec.isUnionTypeReference(prop.type)
            ? prop.type.union.types
            : [prop.type];

          for (const typeToInspect of typesToInspect) {
            if (!spec.isNamedTypeReference(typeToInspect)) {
              continue;
            }

            // Is from a different assembly?
            const typeObj = findType2(typeToInspect.fqn, assembly);
            if (typeObj === 'other-assembly') {
              return true;
            }
            if (this.shouldRenderValidator(typeObj, assembly)) {
              return true;
            }
          }
        }

        for (const interfaceName of type.interfaces ?? []) {
          const typeObj = findType2(interfaceName, assembly);
          if (typeObj === 'other-assembly') {
            return true;
          }
          if (this.shouldRenderValidator(typeObj, assembly)) {
            return true;
          }
        }
      }

      return false;
    }
  }

  private generateTypeValidation(
    type: spec.Type,
    assembly: Assembly,
    projectInfo: ProjectInfo,
    types: Record<string, spec.Type>,
  ): any[] {
    const f = this.f;
    if (!this.shouldRenderValidator(type, assembly)) {
      return [];
    }

    const statements: any[] = [];
    let isEmpty = true;

    // This will add the parameter to the set of visited objects, to prevent infinite recursion
    statements.push(
      f.createExpressionStatement(
        this.call(this.access(this.id(VISITED_OBJECTS_SET_NAME), 'add'), [this.id(PARAMETER_NAME)]),
      ),
    );

    const tryStatements = [];
    if (spec.isDeprecated(type) && spec.isEnumType(type)) {
      // The type is deprecated
      tryStatements.push(this.createWarningFunctionCall(type.fqn, type.docs?.deprecated));
      isEmpty = false;
    }

    if (spec.isEnumType(type) && type.locationInModule?.filename) {
      // Check for deprecated enum members
      //
      // We need to compare to the value of the deprecated enum. We can do that in one of 2 ways:
      //
      // - Compare against `require('./actual-file').EnumType.SOME_ENUM_MEMBER`
      // - Look up the enum member value and compare against `'some-enum-member'`.
      //
      // The first one introduces a circular dependency between this file and `actual-file.js`, so we
      // will go with the second.
      //
      // One complication: two enum members can have the same value (shouldn't, but can!) where
      // one symbolic name is deprecated but the other isn't. In that case we don't treat it as deprecated.
      const memDecls = this.enumMembers.get(type.fqn) ?? new Map<string, any>();
      const constantValue = (name: string): string | number =>
        this.project.checker.getConstantValue(memDecls.get(name)?.resolve(this.project));

      const nonDeprecatedValues = new Set(
        (type.members ?? []).filter((m) => !spec.isDeprecated(m)).map((m) => constantValue(m.name)),
      );
      const deprecatedMembers = (type.members ?? []).filter(spec.isDeprecated);

      for (const member of deprecatedMembers) {
        const value = constantValue(member.name);
        if (nonDeprecatedValues.has(value)) {
          // Collission with non-deprecated enum member
          continue;
        }

        const condition = this.binary(
          this.id(PARAMETER_NAME),
          this.k.EqualsEqualsEqualsToken,
          typeof value === 'string' ? f.createStringLiteral(value, 0) : f.createNumericLiteral(String(value), 0),
        );
        tryStatements.push(
          this.createWarningFunctionCall(`${type.fqn}#${member.name}`, member.docs?.deprecated, condition),
        );
        isEmpty = false;
      }
    } else if (spec.isInterfaceType(type) && type.datatype) {
      const { statementsByProp, excludedProps } = this.processInterfaceType(
        type,
        types,
        assembly,
        projectInfo,
        undefined,
        undefined,
      );

      for (const [name, statement] of statementsByProp.entries()) {
        if (!excludedProps.has(name)) {
          tryStatements.push(statement);
          isEmpty = false;
        }
      }
    }

    statements.push(
      f.createTryStatement(
        f.createBlock(tryStatements),
        undefined,
        f.createBlock([
          f.createExpressionStatement(
            this.call(this.access(this.id(VISITED_OBJECTS_SET_NAME), 'delete'), [this.id(PARAMETER_NAME)]),
          ),
        ]),
      ),
    );

    return isEmpty ? [] : statements;
  }

  private processInterfaceType(
    type: spec.InterfaceType,
    types: { [p: string]: spec.Type },
    assembly: Assembly,
    projectInfo: ProjectInfo,
    statementsByProp: Map<string, any> = new Map<string, any>(),
    excludedProps: Set<string> = new Set<string>(),
  ) {
    for (const prop of Object.values(type.properties ?? {})) {
      const fqn = `${type.fqn}#${prop.name}`;
      if (spec.isDeprecated(prop) || spec.isDeprecated(type)) {
        // If the property individually is deprecated, or the entire type is deprecated
        const deprecatedDocs = prop.docs?.deprecated ?? type.docs?.deprecated;
        const statement = this.createWarningFunctionCall(
          fqn,
          deprecatedDocs,
          this.binary(this.f.createStringLiteral(prop.name, 0), this.k.InKeyword, this.id(PARAMETER_NAME)),
        );
        statementsByProp.set(prop.name, statement);
      } else {
        /* If a prop is not deprecated, we don't want to generate a warning for it,
          even if another property with the same name is deprecated in another
          super-interface. */
        excludedProps.add(prop.name);
      }

      if (spec.isNamedTypeReference(prop.type)) {
        if (!types[prop.type.fqn] || this.shouldRenderValidator(types[prop.type.fqn], assembly)) {
          const functionName = importedFunctionName(prop.type.fqn, assembly, projectInfo);
          if (functionName) {
            const statement = this.createTypeHandlerCall(functionName, `${PARAMETER_NAME}.${prop.name}`);
            statementsByProp.set(`${prop.name}_`, statement);
          }
        }
      } else if (
        spec.isCollectionTypeReference(prop.type) &&
        spec.isNamedTypeReference(prop.type.collection.elementtype)
      ) {
        const functionName = importedFunctionName(prop.type.collection.elementtype.fqn, assembly, projectInfo);
        if (functionName) {
          const statement = this.createTypeHandlerCall(
            functionName,
            `${PARAMETER_NAME}.${prop.name}`,
            prop.type.collection.kind,
          );
          statementsByProp.set(`${prop.name}_`, statement);
        }
      } else if (spec.isUnionTypeReference(prop.type)) {
        for (const unionType of prop.type.union.types) {
          if (!spec.isNamedTypeReference(unionType)) {
            continue;
          }
          if (!types[unionType.fqn] || this.shouldRenderValidator(types[unionType.fqn], assembly)) {
            const functionName = importedFunctionName(unionType.fqn, assembly, projectInfo);
            if (functionName) {
              const statement = this.createTypeHandlerCall(functionName, `${PARAMETER_NAME}.${prop.name}`);
              statementsByProp.set(`${prop.name}_`, statement);
              break;
            }
          }
        }
      }
    }

    // We also generate calls to all the supertypes
    for (const interfaceName of type.interfaces ?? []) {
      const assemblies = projectInfo.dependencyClosure.concat(assembly);
      const superType = findType(interfaceName, assemblies);
      if (superType.type) {
        this.processInterfaceType(
          superType.type as spec.InterfaceType,
          types,
          assembly,
          projectInfo,
          statementsByProp,
          excludedProps,
        );
      }
    }
    return { statementsByProp, excludedProps };
  }

  private createFunctionBlock(statements: any[]): any {
    const f = this.f;
    if (statements.length > 0) {
      const validation = f.createIfStatement(
        this.binary(this.id(PARAMETER_NAME), this.k.EqualsEqualsToken, f.createKeywordExpression(this.k.NullKeyword)),
        f.createReturnStatement(),
      );
      return f.createBlock([validation, ...statements], true);
    }
    return f.createBlock([], true);
  }

  private createWarningFunctionCall(fqn: string, message = '', condition?: any): any {
    const f = this.f;
    const mainStatement = f.createExpressionStatement(
      this.call(this.id(WARNING_FUNCTION_NAME), [f.createStringLiteral(fqn, 0), f.createStringLiteral(message, 0)]),
    );

    return condition ? f.createIfStatement(condition, mainStatement) : mainStatement;
  }

  private createTypeHandlerCall(functionName: string, parameter: string, collectionKind?: spec.CollectionKind): any {
    const f = this.f;
    const notNull = () =>
      this.binary(this.id(parameter), this.k.ExclamationEqualsToken, f.createKeywordExpression(this.k.NullKeyword));
    const loopItem = () =>
      f.createVariableDeclarationList([f.createVariableDeclaration(this.id(FOR_LOOP_ITEM_NAME))], this.nodeFlags.Const);
    switch (collectionKind) {
      case spec.CollectionKind.Array:
        return f.createIfStatement(
          notNull(),
          f.createForOfStatement(
            undefined,
            loopItem(),
            this.id(parameter),
            this.createTypeHandlerCall(functionName, FOR_LOOP_ITEM_NAME),
          ),
        );
      case spec.CollectionKind.Map:
        return f.createIfStatement(
          notNull(),
          f.createForOfStatement(
            undefined,
            loopItem(),
            this.call(this.access(this.id('Object'), 'values'), [this.id(parameter)]),
            this.createTypeHandlerCall(functionName, FOR_LOOP_ITEM_NAME),
          ),
        );
      case undefined:
        return f.createIfStatement(
          f.createPrefixUnaryExpression(
            this.k.ExclamationToken,
            this.call(this.access(this.id(VISITED_OBJECTS_SET_NAME), 'has'), [this.id(parameter)]),
          ),
          this.createValidatorInvocation(functionName, parameter),
        );
    }
  }

  private createValidatorInvocation(functionName: string, parameter: string): any {
    const f = this.f;
    const call = f.createExpressionStatement(this.call(this.id(functionName), [this.id(parameter)]));
    if (!functionName.startsWith('require(')) {
      return call;
    }

    // Dependencies may ship without a compatible warnings module. Preserve intentional deprecation failures.
    return f.createTryStatement(
      f.createBlock([call]),
      f.createCatchClause(
        f.createVariableDeclaration(this.id('error')),
        f.createBlock([
          f.createIfStatement(
            this.binary(
              f.createPropertyAccessExpression(
                this.id('error'),
                f.createToken(this.k.QuestionDotToken),
                this.id('name'),
                this.nodeFlags.OptionalChain,
              ),
              this.k.EqualsEqualsEqualsToken,
              f.createStringLiteral(DEPRECATION_ERROR, 0),
            ),
            f.createThrowStatement(this.id('error')),
          ),
        ]),
      ),
      undefined,
    );
  }

  private id(text: string): any {
    return this.f.createIdentifier(text);
  }

  private access(expression: any, name: string): any {
    return this.f.createPropertyAccessExpression(expression, undefined, this.id(name), this.nodeFlags.None);
  }

  private call(expression: any, args: any[]): any {
    return this.f.createCallExpression(expression, undefined, undefined, args, this.nodeFlags.None);
  }

  private binary(left: any, operator: any, right: any): any {
    return this.f.createBinaryExpression(undefined, left, undefined, this.f.createToken(operator), right);
  }
}

function fnName(fqn: string): string {
  return fqn.replace(/[^\w\d]/g, '_');
}

function findType2(fqn: string, assembly: Assembly): spec.Type | 'other-assembly' {
  // Is from a different assembly?
  if (!fqn.startsWith(`${assembly.name}.`)) {
    return 'other-assembly';
  }

  const type = (assembly.types ?? {})[fqn];
  if (!type) {
    throw new Error(`Could not find type in same assembly: ${fqn}`);
  }
  return type;
}

/**
 * Returns a ready-to-used function name (including a `require`, if necessary)
 */
function importedFunctionName(typeName: string, assembly: Assembly, projectInfo: ProjectInfo) {
  const assemblies = projectInfo.dependencyClosure.concat(assembly);
  const { type, moduleName } = findType(typeName, assemblies);
  if (type) {
    return moduleName !== assembly.name
      ? `require("${moduleName}/${WARNINGSCODE_FILE_NAME}").${fnName(type.fqn)}`
      : `module.exports.${fnName(type.fqn)}`;
  }
  return undefined;
}

/**
 * Find the type and module name in an array of assemblies
 * matching a given type name
 */
function findType(typeName: string, assemblies: readonly Assembly[]) {
  for (const asm of assemblies) {
    if (asm.metadata?.jsii?.compiledWithDeprecationWarnings) {
      const types = asm.types ?? {};
      for (const name of Object.keys(types)) {
        if (typeName === name) {
          return { type: types[name], moduleName: asm.name };
        }
      }
    }
  }
  return {};
}

/**
 * The fixed part of `.warnings.jsii.js`, after the validators. This is the
 * exact text the classic compiler produced by printing its (constant) template
 * with the TypeScript printer.
 */
const WARNINGS_FILE_RUNTIME = `function ${WARNING_FUNCTION_NAME}(name, deprecationMessage) {
    if (ALREADY_WARNED.has(name)) {
        return;
    }
    ALREADY_WARNED.add(name);
    const deprecated = process.env.JSII_DEPRECATED;
    const deprecationMode = ["warn", "fail", "quiet"].includes(deprecated) ? deprecated : "warn";
    const message = \`\${name} is deprecated, and will be removed in the next major release.\\n  \${deprecationMessage.trim()}\`;
    switch (deprecationMode) {
        case "fail":
            throw new ${DEPRECATION_ERROR}(message);
        case "warn":
            console.warn("[WARNING]", message);
            break;
    }
}
const ALREADY_WARNED = new Set();
function ${GET_PROPERTY_DESCRIPTOR}(obj, prop) {
    const descriptor = Object.getOwnPropertyDescriptor(obj, prop);
    if (descriptor) {
        return descriptor;
    }
    const proto = Object.getPrototypeOf(obj);
    const prototypeDescriptor = proto && getPropertyDescriptor(proto, prop);
    if (prototypeDescriptor) {
        return prototypeDescriptor;
    }
    return {};
}
const ${VISITED_OBJECTS_SET_NAME} = new Set();
class ${DEPRECATION_ERROR} extends Error {
    constructor(...args) {
        super(...args);
        Object.defineProperty(this, "name", {
            configurable: false,
            enumerable: true,
            value: "${DEPRECATION_ERROR}",
            writable: false,
        });
    }
}
function nop() {
}
module.exports = new Proxy({}, {
    get(target, prop, receiver) {
        if (prop === "${WARNING_FUNCTION_NAME}")
            return ${WARNING_FUNCTION_NAME};
        if (prop === "${GET_PROPERTY_DESCRIPTOR}")
            return ${GET_PROPERTY_DESCRIPTOR};
        if (prop === "${DEPRECATION_ERROR}")
            return ${DEPRECATION_ERROR};
        return ${VALIDATORS_OBJ}[prop] ?? nop;
    },
});
`;
