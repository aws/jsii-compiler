import * as ts from 'typescript';
import { JsiiDiagnostic } from './jsii-diagnostic';

/**
 * TSDoc-style directives that can be attached to a symbol.
 */
export class Directives {
  /**
   * Obtains the `Directives` for a given TypeScript AST node.
   *
   * @param node         the node for which directives are requested.
   * @param onDiagnostic a callback invoked whenever a diagnostic message is
   *                     emitted when parsing directives.
   */
  public static of(node: ts.Node, onDiagnostic: (diag: JsiiDiagnostic) => void): Directives {
    const found = Directives.#CACHE.get(node);
    if (found != null) {
      return found;
    }

    const directives = new Directives(node, onDiagnostic);
    Directives.#CACHE.set(node, directives);
    return directives;
  }

  static readonly #CACHE = new WeakMap<ts.Node, Directives>();

  /** Whether the node has the `@internal` JSDoc tag. */
  public readonly tsInternal?: ts.JSDocTag;
  /** Whether the node has the `@jsii ignore` directive set. */
  public readonly ignore?: ts.JSDocComment | ts.JSDocTag;
  /** Whether the node has the `@jsii struct` directive set. */
  public readonly struct?: ts.JSDocComment | ts.JSDocTag;

  private constructor(node: ts.Node, onDiagnostic: (diag: JsiiDiagnostic) => void) {
    for (const tag of ts.getJSDocTags(node)) {
      switch (tag.tagName.text) {
        case 'internal':
          this.tsInternal ??= tag;
          break;
        case 'jsii':
          const comments = getComments(tag);
          if (comments.length === 0) {
            onDiagnostic(JsiiDiagnostic.JSII_2000_MISSING_DIRECTIVE_ARGUMENT.create(tag));
            continue;
          }
          for (const { text, jsdocNode } of comments) {
            switch (text) {
              case 'ignore':
                this.ignore ??= jsdocNode;
                break;
              default:
                onDiagnostic(JsiiDiagnostic.JSII_2999_UNKNOWN_DIRECTIVE.create(jsdocNode, text));
                break;
            }
          }
          break;
        default: // Ignore
      }
    }
  }
}

function getComments(tag: ts.JSDocTag): Comment[] {
  if (tag.comment == null) {
    return [];
  }

  if (typeof tag.comment === 'string') {
    const text = tag.comment.trim();
    return text
      ? text.split(/[\n,]/).flatMap((line) => {
          line = line.trim();
          return line ? [{ text: line, jsdocNode: tag }] : [];
        })
      : [];
  }

  // Possible per the type signature in the compiler, however not sure in which conditions.
  return tag.comment.flatMap((jsdocNode): Comment[] => {
    let text: string;
    switch (jsdocNode.kind) {
      case ts.SyntaxKind.JSDocText:
        text = jsdocNode.text;
        break;
      case ts.SyntaxKind.JSDocLink:
      case ts.SyntaxKind.JSDocLinkCode:
      case ts.SyntaxKind.JSDocLinkPlain:
        text = jsdocNode.name
          ? `${jsdocNode.name.getText(jsdocNode.name.getSourceFile())}: ${jsdocNode.text}`
          : jsdocNode.text;
        break;
    }
    text = text.trim();
    return text ? [{ text, jsdocNode }] : [];
  });
}

interface Comment {
  readonly text: string;
  readonly jsdocNode: ts.JSDocComment | ts.JSDocTag;
}
