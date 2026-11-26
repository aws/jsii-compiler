import { DiagnosticLocation, JsiiDiagnostic } from './jsii-diagnostic';

/**
 * The part of a TypeScript AST node that directives are read from. Both the
 * nodes of the TypeScript 7 API and the nodes of the in-process TypeScript 6
 * API (used by the tests) have this shape, so this module does not depend on
 * either of them.
 */
export interface DirectiveNode {
  getSourceFile(): { readonly fileName: string; readonly text?: string };
}

/** A JSDoc tag (`@internal`, `@jsii ...`), or a part of its comment. */
export interface DirectiveJSDocNode {
  /** Offset of the start of the node (the `@` of a tag). */
  readonly pos: number;
  /** Offset of the end of the node. */
  readonly end: number;
}

/** A JSDoc tag. */
export interface DirectiveJSDocTag extends DirectiveJSDocNode {
  readonly tagName: { readonly text: string };
  readonly comment?: string | readonly DirectiveJSDocCommentPart[];
}

/** A text or `{@link}` part of the comment of a JSDoc tag. */
export interface DirectiveJSDocCommentPart extends DirectiveJSDocNode {
  readonly text?: string;
  /** Set on `{@link name text}`. */
  readonly name?: { getText(sourceFile?: any): string; getSourceFile(): unknown };
}

/** The JSDoc data TypeScript attaches to declaration nodes. */
interface JSDocContainer {
  readonly jsDoc?: ReadonlyArray<{ readonly tags?: readonly DirectiveJSDocTag[] }>;
}

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
  public static of(node: DirectiveNode, onDiagnostic: (diag: JsiiDiagnostic) => void): Directives {
    const found = Directives.#CACHE.get(node);
    if (found != null) {
      return found;
    }

    const directives = new Directives(node, onDiagnostic);
    Directives.#CACHE.set(node, directives);
    return directives;
  }

  static readonly #CACHE = new WeakMap<DirectiveNode, Directives>();

  /** Whether the node has the `@internal` JSDoc tag. */
  public readonly tsInternal?: DirectiveJSDocTag;
  /** Whether the node has the `@jsii ignore` directive set. */
  public readonly ignore?: DirectiveJSDocNode;
  /** Whether the node has the `@jsii struct` directive set. */
  public readonly struct?: DirectiveJSDocNode;
  /** Suppression codes from `@jsii suppress <code>` directives. */
  public readonly suppressions: readonly string[] = [];

  private constructor(node: DirectiveNode, onDiagnostic: (diag: JsiiDiagnostic) => void) {
    const suppressions: string[] = [];
    for (const tag of jsDocTagsOf(node)) {
      switch (tag.tagName.text) {
        case 'internal':
          this.tsInternal ??= tag;
          break;
        case 'jsii':
          const comments = getComments(tag);
          if (comments.length === 0) {
            onDiagnostic(JsiiDiagnostic.JSII_2000_MISSING_DIRECTIVE_ARGUMENT.create(locationOf(node, tag)));
            continue;
          }
          for (const { text, jsdocNode } of comments) {
            const [subcommand, ...rest] = text.split(/\s+/);
            switch (subcommand) {
              case 'ignore':
                this.ignore ??= jsdocNode;
                break;
              case 'suppress': {
                const code = rest[0];
                if (code) {
                  suppressions.push(code);
                }
                break;
              }
              default:
                onDiagnostic(JsiiDiagnostic.JSII_2999_UNKNOWN_DIRECTIVE.create(locationOf(node, jsdocNode), text));
                break;
            }
          }
          break;
        default: // Ignore
      }
    }
    this.suppressions = suppressions;
  }
}

/**
 * The JSDoc tags written on the node itself.
 *
 * shortcut: the TypeScript 6 `getJSDocTags` also returns the tags of the
 * statement that holds a variable declaration, and similar cases for
 * parameters and property assignments. jsii only reads directives from
 * declarations that carry their own JSDoc block (classes, interfaces, enums,
 * namespaces and their members), so those are not followed.
 */
function jsDocTagsOf(node: DirectiveNode): readonly DirectiveJSDocTag[] {
  return ((node as JSDocContainer).jsDoc ?? []).flatMap((doc) => Array.from(doc.tags ?? []));
}

function locationOf(node: DirectiveNode, jsdocNode: DirectiveJSDocNode): DiagnosticLocation {
  const { fileName, text } = node.getSourceFile();
  return { file: { fileName, text }, start: jsdocNode.pos, length: jsdocNode.end - jsdocNode.pos };
}

function getComments(tag: DirectiveJSDocTag): Comment[] {
  if (tag.comment == null) {
    return [];
  }

  let parts = tag.comment;
  if (typeof parts !== 'string' && !parts.some((part) => part.name != null)) {
    // TypeScript 6 returns the comment as a string when it has no `{@link}`; the
    // TypeScript 7 API always returns the parts.
    parts = parts.map((part) => part.text ?? '').join('');
  }

  if (typeof parts === 'string') {
    const text = parts.trim();
    return text
      ? text.split(/[\n,]/).flatMap((line) => {
          line = line.trim();
          return line ? [{ text: line, jsdocNode: tag }] : [];
        })
      : [];
  }

  return parts.flatMap((jsdocNode): Comment[] => {
    const text = (
      jsdocNode.name ? `${jsdocNode.name.getText(jsdocNode.name.getSourceFile())}: ${jsdocNode.text}` : jsdocNode.text
    )?.trim();
    return text ? [{ text, jsdocNode }] : [];
  });
}

interface Comment {
  readonly text: string;
  readonly jsdocNode: DirectiveJSDocNode;
}
