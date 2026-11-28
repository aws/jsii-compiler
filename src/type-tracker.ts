import * as ts from 'typescript';

/**
 * A class that tracks the TypeScript source AST nodes for certain jsii types
 *
 * This is useful if we need to get additional information that is not currently tracked.
 */
export class TypeTracker {
  private readonly enums: Record<string, ts.EnumDeclaration> = {};

  public registerEnum(fqn: string, decl: ts.EnumDeclaration) {
    this.enums[fqn] = decl;
  }

  public getEnum(fqn: string): ts.EnumDeclaration {
    const ret = this.enums[fqn];
    if (!ret) {
      throw new Error(`No declaration was registered for enum ${fqn}`);
    }
    return ret;
  }

  public getEnumMembers(fqn: string): Record<string, ts.EnumMember> {
    const enumDecl = this.getEnum(fqn);

    return Object.fromEntries(enumDecl.members.filter(ts.isEnumMember).map((mem) => [memberName(mem.name), mem]));
  }
}

/**
 * The name of an enum member, which is an identifier (`A`) or a string literal (`'A'`).
 */
function memberName(x: ts.PropertyName): string {
  if (ts.isIdentifier(x) || ts.isStringLiteral(x)) {
    return x.text;
  }
  throw new Error(`Expected an identifier or a string literal, got ${ts.SyntaxKind[x.kind]}`);
}
