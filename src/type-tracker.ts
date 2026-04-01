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

    return Object.fromEntries(
      enumDecl.members.filter(ts.isEnumMember).map((mem) => [asIdentifier(mem.name).text, mem]),
    );
  }
}

function asIdentifier(x: ts.Node): ts.Identifier {
  if (ts.isIdentifier(x)) {
    return x;
  }
  throw new Error(`Expected identifier, got ${JSON.stringify(x)}`);
}
