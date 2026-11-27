/*
 * The jsii validator: the checks the classic compiler ran on the finished
 * assembly (classic `src/validator.ts`), in the same order and with the same
 * messages.
 *
 * It works on the assembly alone, as the classic validator did. The assembler
 * hands it the declaration it read each type and member from (`bindings`), so
 * that a diagnostic points at the same place in the source; it asks the
 * TypeScript 7 process nothing.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import * as spec from '@jsii/spec';

import * as Case from './case';
import { DiagnosticCategory } from './diagnostic';
import { Code, DiagnosticLocation, DiagnosticMessageFormatter, JsiiDiagnostic } from './jsii-diagnostic';
import { ProjectInfo } from './project-info';
import { createTypeResolver } from './type-reference';

export interface ValidationResult {
  readonly diagnostics: readonly JsiiDiagnostic[];
  readonly emitSkipped: boolean;
  readonly usedFeatures?: spec.JsiiFeature[];
}

/**
 * What the validator needs from the assembler to bind its diagnostics to the
 * source. Without it (as in tests that hand-write an assembly), diagnostics
 * have no location, like those of the classic validator for an unbound member.
 */
export interface ValidatorBindings {
  /** TypeScript 7's `SyntaxKind`. */
  readonly syntaxKind: any;
  /** The TypeScript 7 declaration the assembler read a type or member from. */
  nodeOf(element: object): any | undefined;
  /** Creates the diagnostic bound to `node`, with the assembler's inline suppressions applied. */
  create<T extends DiagnosticMessageFormatter>(
    code: Code<T>,
    node: any | undefined,
    ...args: Parameters<T>
  ): JsiiDiagnostic;
  /** The location of `node`, for related information. */
  location(node: any | undefined): DiagnosticLocation | undefined;
}

const UNBOUND: ValidatorBindings = {
  nodeOf: () => undefined,
  syntaxKind: {},
  create: (code, _node, ...args) => code.create(undefined, ...args),
  location: () => undefined,
};

export class Validator {
  public static VALIDATIONS: ValidationFunction[] = _defaultValidations();

  public constructor(
    public readonly projectInfo: ProjectInfo,
    public readonly assembly: spec.Assembly,
    public readonly bindings: ValidatorBindings = UNBOUND,
  ) {}

  public emit(): ValidationResult {
    const diagnostics = new Array<JsiiDiagnostic>();
    const usedFeatures = new Array<spec.JsiiFeature>();

    for (const validation of Validator.VALIDATIONS) {
      validation(this, this.assembly, diagnostics.push.bind(diagnostics), usedFeatures.push.bind(usedFeatures));
    }

    return {
      diagnostics,
      emitSkipped: diagnostics.some((diag) => diag.category === DiagnosticCategory.Error),
      usedFeatures,
    };
  }
}

export type DiagnosticEmitter = (diag: JsiiDiagnostic) => void;
export type FeatureTracker = (feat: spec.JsiiFeature) => void;
export type ValidationFunction = (
  validator: Validator,
  assembly: spec.Assembly,
  diagnostic: DiagnosticEmitter,
  useFeatures: FeatureTracker,
) => void;

function _defaultValidations(): ValidationFunction[] {
  // The classic order. Not ported yet: _inheritanceDoesNotChangeContracts (JSII5002 to JSII5010) after
  // _allTypeReferencesAreValid.
  return [
    _enumMembersMustUserUpperSnakeCase,
    _memberNamesMustUseCamelCase,
    _staticConstantNamesMustUseUpperSnakeCase,
    _memberNamesMustNotLookLikeJavaGettersOrSetters,
    _allTypeReferencesAreValid,
    _staticMembersAndNestedTypesMustNotSharePascalCaseName,
    _abstractClassesMustImplementAllProperties,
  ];

  function _enumMembersMustUserUpperSnakeCase(
    validator: Validator,
    assembly: spec.Assembly,
    diagnostic: DiagnosticEmitter,
  ) {
    const { bindings } = validator;
    for (const type of _allTypes(assembly)) {
      if (!spec.isEnumType(type)) {
        continue;
      }

      const enumNode = bindings.nodeOf(type);
      for (const member of type.members) {
        if (member.name && !isConstantCase(member.name)) {
          const memberNode = (enumNode?.members ?? []).find(
            (m: any) => m.name?.kind === bindings.syntaxKind.Identifier && m.name.text === member.name,
          );
          report(
            validator,
            diagnostic,
            JsiiDiagnostic.JSII_8001_ALL_CAPS_ENUM_MEMBERS,
            memberNode?.name ?? declarationName(enumNode),
            member.name,
            type.fqn,
          );
        }
      }
    }
  }

  function _memberNamesMustUseCamelCase(validator: Validator, assembly: spec.Assembly, diagnostic: DiagnosticEmitter) {
    for (const { member, type } of _allMembers(assembly)) {
      if (member.static && (member as spec.Property).const) {
        continue;
      }
      if (member.name && member.name !== Case.camel(member.name)) {
        report(
          validator,
          diagnostic,
          JsiiDiagnostic.JSII_8002_CAMEL_CASED_MEMBERS,
          declarationName(validator.bindings.nodeOf(member)),
          member.name,
          type.fqn,
        );
      }
    }
  }

  function _staticConstantNamesMustUseUpperSnakeCase(
    validator: Validator,
    assembly: spec.Assembly,
    diagnostic: DiagnosticEmitter,
  ) {
    for (const { member, type } of _allMembers(assembly)) {
      if (!member.static || !(member as spec.Property).const) {
        continue;
      }
      if (
        member.name &&
        !isConstantCase(member.name) &&
        member.name !== Case.pascal(member.name) &&
        member.name !== Case.camel(member.name)
      ) {
        report(
          validator,
          diagnostic,
          JsiiDiagnostic.JSII_8003_STATIC_CONST_CASING,
          declarationName(validator.bindings.nodeOf(member)),
          member.name,
          type.name,
        );
      }
    }
  }

  function _memberNamesMustNotLookLikeJavaGettersOrSetters(
    validator: Validator,
    assembly: spec.Assembly,
    diagnostic: DiagnosticEmitter,
  ) {
    for (const { member, type } of _allMembers(assembly)) {
      if (!member.name) {
        continue;
      }
      const snakeName = Case.snake(member.name);
      if (snakeName.startsWith('get_') && _isEmpty((member as spec.Method).parameters)) {
        report(
          validator,
          diagnostic,
          JsiiDiagnostic.JSII_5000_JAVA_GETTERS,
          declarationName(validator.bindings.nodeOf(member)),
          member.name,
          type.name,
        );
      } else if (snakeName.startsWith('set_') && ((member as spec.Method).parameters ?? []).length === 1) {
        report(
          validator,
          diagnostic,
          JsiiDiagnostic.JSII_5001_JAVA_SETTERS,
          declarationName(validator.bindings.nodeOf(member)),
          member.name,
          type.name,
        );
      }
    }
  }

  /**
   * Every named type the assembly refers to exists, in this assembly (JSII3000) or in a dependency (JSII9000,
   * JSII9001). Moved here from the assembler (#3079).
   */
  function _allTypeReferencesAreValid(validator: Validator, assembly: spec.Assembly, diagnostic: DiagnosticEmitter) {
    const { bindings } = validator;
    const SyntaxKind = bindings.syntaxKind;
    const refs: Array<{ fqn: string; node: any }> = [];
    const collect = (type: spec.TypeReference | undefined, node: any): void => {
      if (type == null) {
        return;
      }
      if (spec.isNamedTypeReference(type)) {
        refs.push({ fqn: type.fqn, node });
      } else if (spec.isCollectionTypeReference(type)) {
        collect(type.collection.elementtype, node);
      } else if (spec.isUnionTypeReference(type)) {
        for (const t of type.union.types) {
          collect(t, node);
        }
      }
    };
    const types = Object.values(assembly.types ?? {}).filter(spec.isClassOrInterfaceType);
    for (const type of types) {
      const decl = bindings.nodeOf(type);
      const clause = (token: number) => (decl?.heritageClauses ?? []).find((hc: any) => hc.token === token);
      if (spec.isClassType(type)) {
        if (type.base) {
          refs.push({ fqn: type.base, node: clause(SyntaxKind.ExtendsKeyword)?.types[0] });
        }
        for (const param of type.initializer?.parameters ?? []) {
          collect(param.type, bindings.nodeOf(param)?.type);
        }
      }
      for (const iface of type.interfaces ?? []) {
        // As in main: the clause looked up is the other kind's (`implements` for an interface), so the node is lost.
        // @TODO(NEXT): main's validator has this bug (https://github.com/aws/jsii-compiler/issues/3109); after 7.1's
        // first release, use the matching type of the `extends` (interface) or `implements` (class) clause.
        const token = spec.isInterfaceType(type) ? SyntaxKind.ImplementsKeyword : SyntaxKind.ExtendsKeyword;
        refs.push({ fqn: iface, node: clause(token) });
      }
    }
    for (const type of types) {
      for (const prop of type.properties ?? []) {
        collect(prop.type, bindings.nodeOf(prop)?.type);
      }
    }
    for (const type of types) {
      for (const method of type.methods ?? []) {
        collect(method.returns?.type, bindings.nodeOf(method)?.type);
        for (const param of method.parameters ?? []) {
          collect(param.type, bindings.nodeOf(param)?.type);
        }
      }
    }
    for (const { fqn, node } of refs) {
      const [assm] = fqn.split('.');
      if (assm === assembly.name) {
        if (!(fqn in (assembly.types ?? {}))) {
          report(validator, diagnostic, JsiiDiagnostic.JSII_3000_EXPORTED_API_USES_HIDDEN_TYPE, node, fqn);
        }
        continue;
      }
      const dependency = validator.projectInfo.dependencyClosure.find((dep) => dep.name === assm);
      if (dependency == null) {
        report(validator, diagnostic, JsiiDiagnostic.JSII_9000_UNKNOWN_MODULE, node, assm);
      } else if (!(fqn in (dependency.types ?? {}))) {
        report(validator, diagnostic, JsiiDiagnostic.JSII_9001_TYPE_NOT_FOUND, node, { fqn });
      }
    }
  }

  /**
   * A static member and a nested type of a type may not have the same PascalCased name (JSII5020), as Go uses that
   * name for both. Moved here from the assembler (#3089).
   */
  function _staticMembersAndNestedTypesMustNotSharePascalCaseName(
    validator: Validator,
    assembly: spec.Assembly,
    diagnostic: DiagnosticEmitter,
  ) {
    const { bindings } = validator;
    for (const nestedType of Object.values(assembly.types ?? {})) {
      if (nestedType.namespace == null) {
        continue;
      }
      const nestingType = assembly.types![`${assembly.name}.${nestedType.namespace}`];
      if (nestingType == null) {
        continue;
      }
      const nestedTypeName = Case.pascal(nestedType.name);
      const members: Array<spec.Property | spec.Method | spec.EnumMember> = spec.isClassOrInterfaceType(nestingType)
        ? [
            ...(nestingType.methods ?? []).filter((m) => m.static),
            ...(nestingType.properties ?? []).filter((p) => p.static),
          ]
        : nestingType.members;
      for (const member of members) {
        const name = spec.isClassOrInterfaceType(nestingType) ? Case.pascal(member.name) : member.name;
        if (name !== nestedTypeName) {
          continue;
        }
        const node = spec.isClassOrInterfaceType(nestingType)
          ? bindings.nodeOf(member)
          : (bindings.nodeOf(nestingType)?.members ?? []).find((m: any) => m.name?.text === member.name);
        report(
          validator,
          diagnostic,
          JsiiDiagnostic.JSII_5020_STATIC_MEMBER_CONFLICTS_WITH_NESTED_TYPE,
          node,
          nestingType,
          member,
          nestedType,
        ).addRelatedInformationIf(
          bindings.location(bindings.nodeOf(nestedType)),
          'This is the conflicting nested type declaration',
        );
      }
    }
  }

  /**
   * An abstract class declares every optional property of the interfaces it implements, at least as `abstract`
   * (JSII5021); TypeScript already requires the others. Moved here from the assembler (#3089).
   */
  function _abstractClassesMustImplementAllProperties(
    validator: Validator,
    assembly: spec.Assembly,
    diagnostic: DiagnosticEmitter,
  ) {
    const { bindings } = validator;
    const _dereference = createTypeResolver(assembly, validator.projectInfo.dependencyClosure);
    for (const type of Object.values(assembly.types ?? {})) {
      if (!spec.isClassType(type) || !type.abstract) {
        continue;
      }
      const classProps = new Set<string>();
      for (let t: spec.Type | undefined = type; t != null && spec.isClassType(t); ) {
        for (const prop of t.properties ?? []) {
          classProps.add(prop.name);
        }
        t = t.base != null ? _dereference(t.base) : undefined;
      }
      const check = (interfaceFqn: string) => {
        const intf = _dereference(interfaceFqn);
        if (intf == null || !spec.isInterfaceType(intf)) {
          return;
        }
        for (const prop of intf.properties ?? []) {
          if (prop.optional && !classProps.has(prop.name)) {
            report(
              validator,
              diagnostic,
              JsiiDiagnostic.JSII_5021_ABSTRACT_CLASS_MISSING_PROP_IMPL,
              bindings.nodeOf(type),
              intf,
              type,
              prop.name,
            ).addRelatedInformationIf(bindings.location(bindings.nodeOf(prop)), 'The implemented declaration is here.');
          }
        }
        for (const extFqn of intf.interfaces ?? []) {
          check(extFqn);
        }
      };
      for (const implFqn of type.interfaces ?? []) {
        check(implFqn);
      }
    }
  }

  /** The classic `diagnostic(JsiiDiagnostic.JSII_xxxx.create(node, ...args))`. */
  function report<T extends DiagnosticMessageFormatter>(
    validator: Validator,
    diagnostic: DiagnosticEmitter,
    code: Code<T>,
    node: any | undefined,
    ...args: Parameters<T>
  ): JsiiDiagnostic {
    const diag = validator.bindings.create(code, node, ...args);
    diagnostic(diag);
    return diag;
  }
}

function _allTypes(assm: spec.Assembly): spec.Type[] {
  return Object.values(assm.types ?? {});
}

function _allMethods(assm: spec.Assembly): Array<{ member: spec.Method; type: spec.Type }> {
  const methods = new Array<{ member: spec.Method; type: spec.Type }>();
  for (const type of _allTypes(assm)) {
    if (!spec.isClassOrInterfaceType(type)) {
      continue;
    }
    if (!type.methods) {
      continue;
    }
    for (const method of type.methods) methods.push({ member: method, type });
  }
  return methods;
}

function _allProperties(assm: spec.Assembly): Array<{ member: spec.Property; type: spec.Type }> {
  const properties = new Array<{ member: spec.Property; type: spec.Type }>();
  for (const type of _allTypes(assm)) {
    if (!spec.isClassOrInterfaceType(type)) {
      continue;
    }
    if (!type.properties) {
      continue;
    }
    for (const property of type.properties) properties.push({ member: property, type });
  }
  return properties;
}

function _allMembers(assm: spec.Assembly): Array<{ member: spec.Property | spec.Method; type: spec.Type }> {
  return [..._allMethods(assm), ..._allProperties(assm)];
}

function _isEmpty(array: undefined | any[]): array is undefined {
  return array == null || array.length === 0;
}

/**
 * Return whether an identifier only consists of upperchase characters, digits and underscores
 *
 * We have our own check here (isConstantCase) which is more lenient than what
 * `case.constant()` prescribes. We also want to allow combinations of letters
 * and digits without underscores: `C5A`, which `case` would force to `C5_A`.
 * The hint we print will still use `case.constant()` but that is fine.
 */
function isConstantCase(x: string) {
  return !/[^A-Z0-9_]/.exec(x);
}

/** The name of a declaration if it has one, else the declaration itself (classic `ts.getNameOfDeclaration`). */
function declarationName(decl: any | undefined): any {
  return decl?.name ?? decl;
}
