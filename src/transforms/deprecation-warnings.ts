import * as fs from 'node:fs';
import * as path from 'node:path';
import * as spec from '@jsii/spec';
import { Assembly } from '@jsii/spec';
import * as ts from 'typescript';

import { symbolIdentifier } from '../common/symbol-id';
import { ProjectInfo } from '../project-info';
import { TypeTracker } from '../type-tracker';

export const WARNINGSCODE_FILE_NAME = '.warnings.jsii.js';
const WARNING_FUNCTION_NAME = 'print';
const PARAMETER_NAME = 'p';
const FOR_LOOP_ITEM_NAME = 'o';
const NAMESPACE = 'jsiiDeprecationWarnings';
const VISITED_OBJECTS_SET_NAME = 'visitedObjects';
const DEPRECATION_ERROR = 'DeprecationError';
const GET_PROPERTY_DESCRIPTOR = 'getPropertyDescriptor';
const VALIDATORS_OBJ = 'VALIDATORS';

export class DeprecationWarningsInjector {
  private transformers: ts.CustomTransformers = {
    before: [],
  };

  private shouldRenderValidatorCache: Record<string, boolean> = {};
  private validatorCacheSeenSet = new Set<string>();

  public constructor(private readonly typeChecker: ts.TypeChecker, private readonly typeTracker: TypeTracker) {}

  public process(assembly: Assembly, projectInfo: ProjectInfo) {
    const projectRoot = projectInfo.projectRoot;
    const validationFunctions: ts.ObjectLiteralElementLike[] = [];

    const types = assembly.types ?? {};
    for (const type of Object.values(types)) {
      const fnStatements = this.generateTypeValidation(type, assembly, projectInfo, types);
      if (fnStatements.length === 0) {
        continue;
      }

      const paramValue = ts.factory.createParameterDeclaration(undefined, undefined, PARAMETER_NAME);
      const functionName = fnName(type.fqn);
      const functionExpr = ts.factory.createFunctionExpression(
        undefined,
        undefined,
        ts.factory.createIdentifier(functionName),
        [],
        [paramValue],
        undefined,
        createFunctionBlock(fnStatements),
      );
      validationFunctions.push(ts.factory.createPropertyAssignment(functionName, functionExpr));
    }

    const fileStatements: ts.Statement[] = [];
    fileStatements.push(
      ts.factory.createVariableStatement(
        undefined,
        ts.factory.createVariableDeclarationList(
          [
            ts.factory.createVariableDeclaration(
              VALIDATORS_OBJ,
              undefined,
              undefined,
              ts.factory.createObjectLiteralExpression(validationFunctions),
            ),
          ],
          ts.NodeFlags.Const,
        ),
      ),
    );

    this.transformers = {
      before: [
        (context) => {
          const transformer = new Transformer(
            this.typeChecker,
            context,
            projectRoot,
            this.buildTypeIndex(assembly),
            assembly,
          );
          return transformer.transform.bind(transformer);
        },
      ],
    };

    generateWarningsFile(projectRoot, fileStatements);
  }

  public get customTransformers(): ts.CustomTransformers {
    return this.transformers;
  }

  private buildTypeIndex(assembly: Assembly): Map<string, spec.Type> {
    const result = new Map<string, spec.Type>();

    for (const type of Object.values(assembly.types ?? {})) {
      const symbolId = type.symbolId;
      if (symbolId) {
        result.set(symbolId, type);
      }
    }

    return result;
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
   * For the last one we technically return `true`, indicating that a validator
   * *should* be rendered, but when we get to rendering no statements are
   * actually produced and the validator function is never rendered. This was
   * pre-existing behavior that I didn't change because introducing calls into
   * other assemblies out of the blue introduces risk.
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
  ): ts.Statement[] {
    if (!this.shouldRenderValidator(type, assembly)) {
      return [];
    }

    const statements: ts.Statement[] = [];
    let isEmpty = true;

    // This will add the parameter to the set of visited objects, to prevent infinite recursion
    statements.push(
      ts.factory.createExpressionStatement(
        ts.factory.createCallExpression(
          ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier(VISITED_OBJECTS_SET_NAME), 'add'),
          undefined,
          [ts.factory.createIdentifier(PARAMETER_NAME)],
        ),
      ),
    );

    const tryStatements = [];
    if (spec.isDeprecated(type) && spec.isEnumType(type)) {
      // The type is deprecated
      tryStatements.push(createWarningFunctionCall(type.fqn, type.docs?.deprecated));
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
      const memDecls = this.typeTracker.getEnumMembers(type.fqn);

      const nonDeprecatedValues = new Set(
        (type.members ?? [])
          .filter((m) => !spec.isDeprecated(m))
          .map((m) => this.typeChecker.getConstantValue(memDecls[m.name])!),
      );
      const deprecatedMembers = (type.members ?? []).filter(spec.isDeprecated);

      for (const member of deprecatedMembers) {
        const constantValue = this.typeChecker.getConstantValue(memDecls[member.name])!;
        if (nonDeprecatedValues.has(constantValue)) {
          // Collission with non-deprecated enum member
          continue;
        }

        const condition = ts.factory.createBinaryExpression(
          ts.factory.createIdentifier(PARAMETER_NAME),
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          typeof constantValue === 'string'
            ? ts.factory.createStringLiteral(constantValue)
            : ts.factory.createNumericLiteral(constantValue),
        );
        tryStatements.push(createWarningFunctionCall(`${type.fqn}#${member.name}`, member.docs?.deprecated, condition));
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
      ts.factory.createTryStatement(
        ts.factory.createBlock(tryStatements),
        undefined,
        ts.factory.createBlock([
          ts.factory.createExpressionStatement(
            ts.factory.createCallExpression(
              ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier(VISITED_OBJECTS_SET_NAME),
                'delete',
              ),
              undefined,
              [ts.factory.createIdentifier(PARAMETER_NAME)],
            ),
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
    statementsByProp: Map<string, ts.Statement> = new Map<string, ts.Statement>(),
    excludedProps: Set<string> = new Set<string>(),
  ) {
    for (const prop of Object.values(type.properties ?? {})) {
      const fqn = `${type.fqn}#${prop.name}`;
      if (spec.isDeprecated(prop) || spec.isDeprecated(type)) {
        // If the property individually is deprecated, or the entire type is deprecated
        const deprecatedDocs = prop.docs?.deprecated ?? type.docs?.deprecated;
        const statement = createWarningFunctionCall(
          fqn,
          deprecatedDocs,
          ts.factory.createBinaryExpression(
            ts.factory.createStringLiteral(prop.name),
            ts.SyntaxKind.InKeyword,
            ts.factory.createIdentifier(PARAMETER_NAME),
          ),
          undefined,
        );
        statementsByProp.set(prop.name, statement);
      } else {
        /* If a prop is not deprecated, we don't want to generate a warning for it,
          even if another property with the same name is deprecated in another
          super-interface. */
        excludedProps.add(prop.name);
      }

      if (spec.isNamedTypeReference(prop.type) && Object.keys(types).includes(prop.type.fqn)) {
        if (this.shouldRenderValidator(types[prop.type.fqn], assembly)) {
          const functionName = importedFunctionName(prop.type.fqn, assembly, projectInfo);
          if (functionName) {
            const statement = createTypeHandlerCall(functionName, `${PARAMETER_NAME}.${prop.name}`);
            statementsByProp.set(`${prop.name}_`, statement);
          }
        }
      } else if (
        spec.isCollectionTypeReference(prop.type) &&
        spec.isNamedTypeReference(prop.type.collection.elementtype)
      ) {
        const functionName = importedFunctionName(prop.type.collection.elementtype.fqn, assembly, projectInfo);
        if (functionName) {
          const statement = createTypeHandlerCall(
            functionName,
            `${PARAMETER_NAME}.${prop.name}`,
            prop.type.collection.kind,
          );
          statementsByProp.set(`${prop.name}_`, statement);
        }
      } else if (
        spec.isUnionTypeReference(prop.type) &&
        spec.isNamedTypeReference(prop.type.union.types[0]) &&
        Object.keys(types).includes(prop.type.union.types[0].fqn)
      ) {
        const functionName = importedFunctionName(prop.type.union.types[0].fqn, assembly, projectInfo);
        if (functionName) {
          const statement = createTypeHandlerCall(functionName, `${PARAMETER_NAME}.${prop.name}`);
          statementsByProp.set(`${prop.name}_`, statement);
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
}

function fnName(fqn: string): string {
  return fqn.replace(/[^\w\d]/g, '_');
}

function createFunctionBlock(statements: ts.Statement[]): ts.Block {
  if (statements.length > 0) {
    const validation = ts.factory.createIfStatement(
      ts.factory.createBinaryExpression(
        ts.factory.createIdentifier(PARAMETER_NAME),
        ts.SyntaxKind.EqualsEqualsToken,
        ts.factory.createNull(),
      ),
      ts.factory.createReturnStatement(),
    );
    return ts.factory.createBlock([validation, ...statements], true);
  }
  return ts.factory.createBlock([], true);
}

function createWarningFunctionCall(
  fqn: string,
  message = '',
  condition?: ts.Expression,
  includeNamespace = false,
): ts.Statement {
  const functionName = includeNamespace ? `${NAMESPACE}.${WARNING_FUNCTION_NAME}` : WARNING_FUNCTION_NAME;

  const mainStatement = ts.factory.createExpressionStatement(
    ts.factory.createCallExpression(ts.factory.createIdentifier(functionName), undefined, [
      ts.factory.createStringLiteral(fqn),
      ts.factory.createStringLiteral(message),
    ]),
  );

  return condition ? ts.factory.createIfStatement(condition, mainStatement) : mainStatement;
}

function generateWarningsFile(projectRoot: string, validatorStatements: ts.Statement[]) {
  const functionText = `function ${WARNING_FUNCTION_NAME}(name, deprecationMessage) {
  const deprecated = process.env.JSII_DEPRECATED;
  const deprecationMode = ['warn', 'fail', 'quiet'].includes(deprecated) ? deprecated : 'warn';
  const message = \`\${name} is deprecated.\\n  \${deprecationMessage.trim()}\\n  This API will be removed in the next major release.\`;
  switch (deprecationMode) {
    case "fail":
      throw new ${DEPRECATION_ERROR}(message);
    case "warn":
      console.warn("[WARNING]", message);
      break;
  }
}

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
    Object.defineProperty(this, 'name', {
      configurable: false,
      enumerable: true,
      value: '${DEPRECATION_ERROR}',
      writable: false,
    });
  }
}

function nop() {
}

module.exports = new Proxy({}, {
  get(target, prop, receiver) {
    if (prop === '${WARNING_FUNCTION_NAME}') return ${WARNING_FUNCTION_NAME};
    if (prop === '${GET_PROPERTY_DESCRIPTOR}') return ${GET_PROPERTY_DESCRIPTOR};
    if (prop === '${DEPRECATION_ERROR}') return ${DEPRECATION_ERROR};

    return ${VALIDATORS_OBJ}[prop] ?? nop;
  },
});
`;

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const resultFile = ts.createSourceFile(
    path.join(projectRoot, WARNINGSCODE_FILE_NAME),
    functionText,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );

  const declarations = validatorStatements.map((st) => printer.printNode(ts.EmitHint.Unspecified, st, resultFile));

  const content = declarations.concat(printer.printFile(resultFile)).join('\n');

  fs.writeFileSync(path.join(projectRoot, WARNINGSCODE_FILE_NAME), content);
}

class Transformer {
  private warningCallsWereInjected = false;

  public constructor(
    private readonly typeChecker: ts.TypeChecker,
    private readonly context: ts.TransformationContext,
    private readonly projectRoot: string,
    private readonly typeIndex: Map<string, spec.Type>,
    private readonly assembly: Assembly,
  ) {}

  public transform<T extends ts.Node>(node: T): T {
    this.warningCallsWereInjected = false;

    const result = this.visitEachChild(node);

    if (ts.isSourceFile(result) && this.warningCallsWereInjected) {
      const importDir = path.relative(path.dirname(result.fileName), this.projectRoot);
      const importPath = importDir.startsWith('..')
        ? unixPath(path.join(importDir, WARNINGSCODE_FILE_NAME))
        : `./${WARNINGSCODE_FILE_NAME}`;

      return ts.factory.updateSourceFile(result, [
        createRequireStatement(NAMESPACE, importPath),
        ...result.statements,
      ]) as any;
    }
    return result;
  }

  private visitEachChild<T extends ts.Node>(node: T): T {
    return ts.visitEachChild(node, this.visitor.bind(this), this.context);
  }

  private visitor<T extends ts.Node>(node: T): ts.VisitResult<T> {
    if (ts.isMethodDeclaration(node) && node.body != null) {
      const statements = this.getStatementsForDeclaration(node);
      this.warningCallsWereInjected = this.warningCallsWereInjected || statements.length > 0;
      return ts.factory.updateMethodDeclaration(
        node,
        node.modifiers,
        node.asteriskToken,
        node.name,
        node.questionToken,
        node.typeParameters,
        node.parameters,
        node.type,
        ts.factory.updateBlock(node.body, [
          ...wrapWithRethrow(
            statements,
            ts.factory.createPropertyAccessExpression(ts.factory.createThis(), node.name.getText(node.getSourceFile())),
          ),
          ...node.body.statements,
        ]),
      ) as any;
    } else if (ts.isGetAccessorDeclaration(node) && node.body != null) {
      const statements = this.getStatementsForDeclaration(node);
      this.warningCallsWereInjected = this.warningCallsWereInjected || statements.length > 0;
      return ts.factory.updateGetAccessorDeclaration(
        node,
        node.modifiers,
        node.name,
        node.parameters,
        node.type,
        ts.factory.updateBlock(node.body, [
          ...wrapWithRethrow(
            statements,
            ts.factory.createPropertyAccessExpression(
              ts.factory.createCallExpression(
                ts.factory.createPropertyAccessExpression(
                  ts.factory.createIdentifier(NAMESPACE),
                  GET_PROPERTY_DESCRIPTOR,
                ),
                undefined,
                [ts.factory.createThis(), ts.factory.createStringLiteral(node.name.getText(node.getSourceFile()))],
              ),
              'get',
            ),
          ),
          ...node.body.statements,
        ]),
      ) as any;
    } else if (ts.isSetAccessorDeclaration(node) && node.body != null) {
      const statements = this.getStatementsForDeclaration(node);
      this.warningCallsWereInjected = this.warningCallsWereInjected || statements.length > 0;
      return ts.factory.updateSetAccessorDeclaration(
        node,
        node.modifiers,
        node.name,
        node.parameters,
        ts.factory.updateBlock(node.body, [
          ...wrapWithRethrow(
            statements,
            ts.factory.createPropertyAccessExpression(
              ts.factory.createCallExpression(
                ts.factory.createPropertyAccessExpression(
                  ts.factory.createIdentifier(NAMESPACE),
                  GET_PROPERTY_DESCRIPTOR,
                ),
                undefined,
                [ts.factory.createThis(), ts.factory.createStringLiteral(node.name.getText(node.getSourceFile()))],
              ),
              'set',
            ),
          ),
          ...node.body.statements,
        ]),
      ) as any;
    } else if (ts.isConstructorDeclaration(node) && node.body != null) {
      const statements = this.getStatementsForDeclaration(node);
      this.warningCallsWereInjected = this.warningCallsWereInjected || statements.length > 0;
      return ts.factory.updateConstructorDeclaration(
        node,
        node.modifiers,
        node.parameters,
        ts.factory.updateBlock(node.body, insertStatements(node.body, wrapWithRethrow(statements, node.parent.name!))),
      ) as any;
    }

    return this.visitEachChild(node);
  }

  /**
   * @param getOrSet for property accessors, determines which of the getter or
   *                 setter should be used to get the caller function value.
   */
  private getStatementsForDeclaration(
    node: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.ConstructorDeclaration,
  ): ts.Statement[] {
    const klass = node.parent;
    const classSymbolId = symbolIdentifier(this.typeChecker, this.typeChecker.getTypeAtLocation(klass).symbol);
    if (classSymbolId && this.typeIndex.has(classSymbolId)) {
      const classType = this.typeIndex.get(classSymbolId)! as spec.ClassType;

      if (ts.isConstructorDeclaration(node)) {
        const initializer = classType?.initializer;
        if (initializer) {
          return this.getStatements(classType, initializer);
        }
      }

      const methods = classType?.methods ?? [];
      const method = methods.find((m) => m.name === node.name?.getText());
      if (method) {
        return this.getStatements(classType, method);
      }

      const properties = classType?.properties ?? [];
      const property = properties.find((p) => p.name === node.name?.getText());
      if (property) {
        return createWarningStatementForElement(property, classType);
      }
    }
    return [];
  }

  private getStatements(classType: spec.ClassType, method: spec.Method | spec.Initializer) {
    const statements = createWarningStatementForElement(method, classType);
    for (const parameter of Object.values(method.parameters ?? {})) {
      const parameterType =
        this.assembly.types && spec.isNamedTypeReference(parameter.type)
          ? this.assembly.types[parameter.type.fqn]
          : undefined;

      if (parameterType) {
        const functionName = `${NAMESPACE}.${fnName(parameterType.fqn)}`;
        statements.push(
          ts.factory.createExpressionStatement(
            ts.factory.createCallExpression(ts.factory.createIdentifier(functionName), undefined, [
              ts.factory.createIdentifier(parameter.name),
            ]),
          ),
        );
      }
    }

    return statements;
  }
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

function createWarningStatementForElement(
  element: spec.Callable | spec.Property,
  classType: spec.ClassType,
): ts.Statement[] {
  if (spec.isDeprecated(element)) {
    const elementName = (element as spec.Method | spec.Property).name;
    const fqn = elementName ? `${classType.fqn}#${elementName}` : classType.fqn;
    const message = element.docs?.deprecated ?? classType.docs?.deprecated;
    return [createWarningFunctionCall(fqn, message, undefined, true)];
  }
  return [];
}

/**
 * Inserts a list of statements in the correct position inside a block of statements.
 * If there is a `super` call, It inserts the statements just after it. Otherwise,
 * insert the statements right at the beginning of the block.
 */
function insertStatements(block: ts.Block, newStatements: ts.Statement[]) {
  function splicePoint(statement: ts.Statement | undefined) {
    if (statement == null) {
      return 0;
    }
    let isSuper = false;
    statement.forEachChild((node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
        isSuper = true;
      }
    });
    return isSuper ? 1 : 0;
  }

  const result = [...block.statements];
  result.splice(splicePoint(block.statements[0]), 0, ...newStatements);
  return ts.factory.createNodeArray(result);
}

function createRequireStatement(name: string, importPath: string): ts.Statement {
  return ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList(
      [
        ts.factory.createVariableDeclaration(
          name,
          undefined,
          undefined,
          ts.factory.createCallExpression(ts.factory.createIdentifier('require'), undefined, [
            ts.factory.createStringLiteral(importPath),
          ]),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  );
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
function findType(typeName: string, assemblies: Assembly[]) {
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

function createTypeHandlerCall(
  functionName: string,
  parameter: string,
  collectionKind?: spec.CollectionKind,
): ts.Statement {
  switch (collectionKind) {
    case spec.CollectionKind.Array:
      return ts.factory.createIfStatement(
        ts.factory.createBinaryExpression(
          ts.factory.createIdentifier(parameter),
          ts.SyntaxKind.ExclamationEqualsToken,
          ts.factory.createNull(),
        ),
        ts.factory.createForOfStatement(
          undefined,
          ts.factory.createVariableDeclarationList(
            [ts.factory.createVariableDeclaration(FOR_LOOP_ITEM_NAME)],
            ts.NodeFlags.Const,
          ),
          ts.factory.createIdentifier(parameter),
          createTypeHandlerCall(functionName, FOR_LOOP_ITEM_NAME),
        ),
      );
    case spec.CollectionKind.Map:
      return ts.factory.createIfStatement(
        ts.factory.createBinaryExpression(
          ts.factory.createIdentifier(parameter),
          ts.SyntaxKind.ExclamationEqualsToken,
          ts.factory.createNull(),
        ),
        ts.factory.createForOfStatement(
          undefined,
          ts.factory.createVariableDeclarationList(
            [ts.factory.createVariableDeclaration(FOR_LOOP_ITEM_NAME)],
            ts.NodeFlags.Const,
          ),
          ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('Object'), 'values'),
            undefined,
            [ts.factory.createIdentifier(parameter)],
          ),
          createTypeHandlerCall(functionName, FOR_LOOP_ITEM_NAME),
        ),
      );
    case undefined:
      return ts.factory.createIfStatement(
        ts.factory.createPrefixUnaryExpression(
          ts.SyntaxKind.ExclamationToken,
          ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(
              ts.factory.createIdentifier(VISITED_OBJECTS_SET_NAME),
              ts.factory.createIdentifier('has'),
            ),
            undefined,
            [ts.factory.createIdentifier(parameter)],
          ),
        ),
        ts.factory.createExpressionStatement(
          ts.factory.createCallExpression(ts.factory.createIdentifier(functionName), undefined, [
            ts.factory.createIdentifier(parameter),
          ]),
        ),
      );
  }
}

// We try-then-rethrow exceptions to avoid runtimes displaying an uncanny wall of text if the place
// where the error was thrown is webpacked. For example, jest somehow manages to capture the throw
// location and renders the source line (which may be the whole file) when bundled.
function wrapWithRethrow(statements: ts.Statement[], caller: ts.Expression): ts.Statement[] {
  if (statements.length === 0) {
    return statements;
  }
  return [
    ts.factory.createTryStatement(
      ts.factory.createBlock(statements),
      ts.factory.createCatchClause(
        ts.factory.createVariableDeclaration('error'),
        ts.factory.createBlock([
          // If this is a DeprecationError, trim its stack trace to surface level before re-throwing,
          // so we don't carry out possibly confusing frames from injected code. That can be toggled
          // off by setting JSII_DEBUG=1, so we can also diagnose in-injected code faults.
          ts.factory.createIfStatement(
            ts.factory.createBinaryExpression(
              ts.factory.createBinaryExpression(
                ts.factory.createPropertyAccessExpression(
                  ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('process'), 'env'),
                  'JSII_DEBUG',
                ),
                ts.SyntaxKind.ExclamationEqualsEqualsToken,
                ts.factory.createStringLiteral('1'),
              ),
              ts.SyntaxKind.AmpersandAmpersandToken,
              ts.factory.createBinaryExpression(
                ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('error'), 'name'),
                ts.SyntaxKind.EqualsEqualsEqualsToken,
                ts.factory.createStringLiteral(DEPRECATION_ERROR),
              ),
            ),
            ts.factory.createBlock([
              ts.factory.createExpressionStatement(
                ts.factory.createCallExpression(
                  ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('Error'), 'captureStackTrace'),
                  undefined,
                  [ts.factory.createIdentifier('error'), caller],
                ),
              ),
            ]),
          ),
          ts.factory.createThrowStatement(ts.factory.createIdentifier('error')),
        ]),
      ),
      undefined,
    ),
  ];
}

/**
 * Force a path to be UNIXy (use `/` as a separator)
 *
 * `path.join()` etc. will use the system-dependent path separator (either `/` or `\`
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
