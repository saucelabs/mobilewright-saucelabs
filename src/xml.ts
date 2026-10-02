const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
const MAX_CODE_POINT = 0x10ffff;

/** Decodes the five named XML entities and `&#NN;` / `&#xHH;`. Unknown or invalid ones are kept as they are. */
export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (entity, body: string) => {
    if (!body.startsWith('#')) return NAMED_ENTITIES[body] ?? entity;
    const codePoint = body.startsWith('#x') ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : entity;
  });
}

/**
 * Parses the attributes of an XML start tag (the text after the tag name). Values may be double- or
 * single-quoted (`uiautomator dump` single-quotes a value containing `"`), and are entity-decoded.
 */
export function parseXmlAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[m[1]] = decodeXmlEntities(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

/** A node built by parseXmlTree; `toNode` creates it with an empty `children` array. */
interface TreeNode<T> {
  children: T[];
}

/** Parses an XML document into a tree, building each element with `toNode(tag, attributes)`. */
export function parseXmlTree<T extends TreeNode<T>>(xml: string, toNode: (tag: string, attrs: Record<string, string>) => T): T[] {
  const root: T[] = [];
  const stack: T[][] = [root];
  for (const [, closing, tag, attrsRaw] of xml.matchAll(/<(\/?)([A-Za-z_][\w.]*)([^>]*)>/g)) {
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = toNode(tag, parseXmlAttributes(attrsRaw));
    stack[stack.length - 1].push(node);
    if (!attrsRaw.trimEnd().endsWith('/')) stack.push(node.children);
  }
  return root;
}
