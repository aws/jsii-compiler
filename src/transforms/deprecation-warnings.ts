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
 * The calls into that file (the classic `Transformer`) are added to the
 * emitted `.js` after emit, because TypeScript 7 has no transformer hook: see
 * `callInsertions`. The statements are the same; they are printed by the
 * TypeScript 7 printer and spliced into the emitted text at the place the
 * TypeScript 6 printer put them, and the source map is shifted to match.
 * ---------------------------------------------------------------------------
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as spec from '@jsii/spec';
import { Assembly } from '@jsii/spec';

import { TypeScriptApi, TypeScriptProject } from '../compiler-host';
import { ProjectInfo } from '../project-info';
import { EmittedFile, normalizeRel, statementInsertion } from './emitted-js';
import { Insertion } from './source-map';

export const WARNINGSCODE_FILE_NAME = '.warnings.jsii.js';
const WARNING_FUNCTION_NAME = 'print';
const NAMESPACE = 'jsiiDeprecationWarnings';
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
  private classIndex?: Map<string, Map<string, spec.ClassType>>;
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
   * The calls into `.warnings.jsii.js` to add to one emitted `.js` file, as
   * edits of its text, and the `require` statement to put at its top when there
   * are any. A class is the jsii type with the same source file and in-file
   * name (the part of its `symbolId` after `:`), the key the classic
   * transformer used.
   */
  public callInsertions(
    file: EmittedFile,
    assembly: Assembly,
    projectRoot: string,
  ): { readonly edits: Insertion[]; readonly prepend?: string } {
    const k = this.k;
    const { jsText, jsSource, tsFile } = file;
    const typesHere = this.classesOf(assembly, projectRoot).get(normalizeRel(path.relative(projectRoot, tsFile)));
    if (typesHere == null) {
      return { edits: [] };
    }

    const pending: Array<{ statement: any; place: (printed: string) => Insertion[] }> = [];
    for (const { ts: tsClass, js: jsClass, qualifiedName } of file.classes) {
      const classType = qualifiedName != null ? typesHere.get(qualifiedName) : undefined;
      if (classType == null) {
        continue;
      }
      for (const member of jsClass.members) {
        if (
          member.body == null ||
          ![k.MethodDeclaration, k.GetAccessor, k.SetAccessor, k.Constructor].includes(member.kind)
        ) {
          continue;
        }
        const name: string | undefined = member.name?.getText(jsSource);
        const statements = this.statementsForMember(member.kind, name, classType, assembly);
        if (statements.length === 0) {
          continue;
        }
        const caller =
          member.kind === k.MethodDeclaration
            ? this.access(this.f.createKeywordExpression(k.ThisKeyword), name!)
            : member.kind === k.Constructor
            ? this.id(tsClass.name.text)
            : this.access(
                this.call(this.access(this.id(NAMESPACE), GET_PROPERTY_DESCRIPTOR), [
                  this.f.createKeywordExpression(k.ThisKeyword),
                  this.f.createStringLiteral(name!, 0),
                ]),
                member.kind === k.GetAccessor ? 'get' : 'set',
              );
        const index =
          member.kind === k.Constructor ? member.body.statements.length - constructorBodyStatements(tsClass, k) : 0;
        pending.push({
          statement: this.wrapWithRethrow(statements, caller),
          place: (printed) => statementInsertion(jsText, jsSource, member, index, printed),
        });
      }
    }

    if (pending.length === 0) {
      return { edits: [] };
    }
    const printed: string[] = this.project.api.batch(
      ...pending.map((p) => this.project.api.printer.printNode.gen(p.statement)),
    );

    const importDir = path.relative(path.dirname(tsFile), projectRoot);
    const importPath = importDir.startsWith('..')
      ? unixPath(path.join(importDir, WARNINGSCODE_FILE_NAME))
      : `./${WARNINGSCODE_FILE_NAME}`;
    return {
      edits: pending.flatMap((p, i) => p.place(printed[i])),
      prepend: `const ${NAMESPACE} = require("${importPath}");`,
    };
  }

  /** Assembly classes by `.ts` file (relative to the project root) and in-file name. */
  private classesOf(assembly: Assembly, projectRoot: string): Map<string, Map<string, spec.ClassType>> {
    if (this.classIndex == null) {
      this.classIndex = new Map();
      for (const type of Object.values(assembly.types ?? {})) {
        const file = type.locationInModule?.filename;
        const inFileName = type.symbolId?.slice(type.symbolId.lastIndexOf(':') + 1);
        if (!spec.isClassType(type) || file == null || inFileName == null) {
          continue;
        }
        const key = normalizeRel(path.relative(projectRoot, path.resolve(projectRoot, file)));
        if (!this.classIndex.has(key)) {
          this.classIndex.set(key, new Map());
        }
        this.classIndex.get(key)!.set(inFileName, type);
      }
    }
    return this.classIndex;
  }

  /** The classic `getStatementsForDeclaration`, keyed by member kind and name. */
  private statementsForMember(
    kind: any,
    name: string | undefined,
    classType: spec.ClassType,
    assembly: Assembly,
  ): any[] {
    if (kind === this.k.Constructor) {
      const initializer = classType?.initializer;
      if (initializer) {
        return this.getStatements(classType, initializer, assembly);
      }
    }

    const methods = classType?.methods ?? [];
    const method = methods.find((m) => m.name === name);
    if (method) {
      return this.getStatements(classType, method, assembly);
    }

    const properties = classType?.properties ?? [];
    const property = properties.find((p) => p.name === name);
    if (property) {
      return this.createWarningStatementForElement(property, classType);
    }
    return [];
  }

  private getStatements(classType: spec.ClassType, method: spec.Method | spec.Initializer, assembly: Assembly) {
    const statements = this.createWarningStatementForElement(method, classType);
    for (const parameter of Object.values(method.parameters ?? {})) {
      const parameterType =
        assembly.types && spec.isNamedTypeReference(parameter.type) ? assembly.types[parameter.type.fqn] : undefined;

      if (parameterType) {
        const functionName = `${NAMESPACE}.${fnName(parameterType.fqn)}`;
        statements.push(this.f.createExpressionStatement(this.call(this.id(functionName), [this.id(parameter.name)])));
      }
    }

    return statements;
  }

  private createWarningStatementForElement(element: spec.Callable | spec.Property, classType: spec.ClassType): any[] {
    if (spec.isDeprecated(element)) {
      const elementName = (element as spec.Method | spec.Property).name;
      const fqn = elementName ? `${classType.fqn}#${elementName}` : classType.fqn;
      const message = element.docs?.deprecated ?? classType.docs?.deprecated;
      return [this.createWarningFunctionCall(fqn, message, undefined, true)];
    }
    return [];
  }

  // We try-then-rethrow exceptions to avoid runtimes displaying an uncanny wall of text if the place
  // where the error was thrown is webpacked. For example, jest somehow manages to capture the throw
  // location and renders the source line (which may be the whole file) when bundled.
  private wrapWithRethrow(statements: any[], caller: any): any {
    const f = this.f;
    const k = this.k;
    return f.createTryStatement(
      f.createBlock(statements),
      f.createCatchClause(
        f.createVariableDeclaration(this.id('error')),
        f.createBlock([
          // If this is a DeprecationError, trim its stack trace to surface level before re-throwing,
          // so we don't carry out possibly confusing frames from injected code. That can be toggled
          // off by setting JSII_DEBUG=1, so we can also diagnose in-injected code faults.
          f.createIfStatement(
            this.binary(
              this.binary(
                this.access(this.access(this.id('process'), 'env'), 'JSII_DEBUG'),
                k.ExclamationEqualsEqualsToken,
                f.createStringLiteral('1', 0),
              ),
              k.AmpersandAmpersandToken,
              this.binary(
                this.access(this.id('error'), 'name'),
                k.EqualsEqualsEqualsToken,
                f.createStringLiteral(DEPRECATION_ERROR, 0),
              ),
            ),
            f.createBlock([
              f.createExpressionStatement(
                this.call(this.access(this.id('Error'), 'captureStackTrace'), [this.id('error'), caller]),
              ),
            ]),
          ),
          f.createThrowStatement(this.id('error')),
        ]),
      ),
      undefined,
    );
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

  private createWarningFunctionCall(fqn: string, message = '', condition?: any, includeNamespace = false): any {
    const f = this.f;
    const functionName = includeNamespace ? `${NAMESPACE}.${WARNING_FUNCTION_NAME}` : WARNING_FUNCTION_NAME;
    const mainStatement = f.createExpressionStatement(
      this.call(this.id(functionName), [f.createStringLiteral(fqn, 0), f.createStringLiteral(message, 0)]),
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

/**
 * How many statements of the emitted constructor body come from the `.ts`
 * constructor body after a leading `super(...)` call. The classic transformer
 * put its statements before those; the emit adds parameter properties (and
 * field initializers) before them too.
 */
function constructorBodyStatements(tsClass: any, k: any): number {
  const ctor = tsClass.members.find((m: any) => m.kind === k.Constructor && m.body != null);
  const statements: any[] = ctor?.body?.statements ?? [];
  const first = statements[0];
  const hasSuper =
    first?.kind === k.ExpressionStatement &&
    first.expression.kind === k.CallExpression &&
    first.expression.expression.kind === k.SuperKeyword;
  // shortcut: erased statements (types declared in the body) are not counted out; no jsii code does that.
  return statements.length - (hasSuper ? 1 : 0);
}

/**
 * Force a path to be UNIXy (use `/` as a separator)
 *
 * `path.join()` etc. will use the system-dependent path separator (either `/` or `\\`
 * depending on your platform).
 *
 * However, if we actually emit the path-dependent separator to the `.js` files, then
 * files compiled with jsii on Windows cannot be used on any other platform. That seems
 * like an unnecessary restriction, especially since a `/` will work fine on Windows,
 * so make sure to always emit `/`.
 *
 * TSC itself always strictly emits `/` (or at least, emits the same what you put in).
 */
function unixPath(filePath: string) {
  if (path.sep === '\\') {
    return filePath.replace(/\\/g, '/');
  }
  return filePath;
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
