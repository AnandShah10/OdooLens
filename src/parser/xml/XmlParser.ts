import { SaxesParser, SaxesTagPlain } from 'saxes';
import { XmlNodeRef } from '../../semantic/OdooTypes';

export interface XmlParseResult {
  root: XmlNodeRef | null;
  errors: string[];
}

/**
 * Parses an XML file into a lightweight tree that preserves per-node source locations,
 * so downstream analyzers (view inheritance, XPath validation) can point diagnostics at
 * exact lines/columns. Uses `saxes`, a real streaming XML parser, rather than regex.
 */
export function parseXml(filePath: string, source: string): XmlParseResult {
  const parser = new SaxesParser({ xmlns: false, position: true });
  const errors: string[] = [];
  const stack: XmlNodeRef[] = [];
  let root: XmlNodeRef | null = null;

  // Track start position per open tag so we can compute an accurate end position on close.
  const startPositions: number[] = [];

  parser.on('error', (e) => {
    errors.push(e.message);
  });

  parser.on('opentag', (node: SaxesTagPlain) => {
    const attributes: Record<string, string> = {};
    for (const [k, v] of Object.entries(node.attributes)) {
      attributes[k] = String(v);
    }
    const startLine = parser.line - 1; // saxes is 1-based
    const startCol = parser.column;
    const ref: XmlNodeRef = {
      tag: node.name,
      attributes,
      children: [],
      location: { file: filePath, startLine, startCol, endLine: startLine, endCol: startCol },
    };
    if (stack.length > 0) {
      ref.parent = stack[stack.length - 1];
      stack[stack.length - 1].children.push(ref);
    } else {
      root = ref;
    }
    stack.push(ref);
    startPositions.push(startLine);
  });

  parser.on('closetag', () => {
    const node = stack.pop();
    if (node) {
      node.location.endLine = parser.line - 1;
      node.location.endCol = parser.column;
    }
  });

  parser.on('text', (t: string) => {
    if (stack.length > 0) {
      const trimmed = t.trim();
      if (trimmed) stack[stack.length - 1].text = (stack[stack.length - 1].text ?? '') + trimmed;
    }
  });

  try {
    parser.write(source).close();
  } catch (e: any) {
    errors.push(String(e?.message ?? e));
  }

  return { root, errors };
}

export function findDescendants(node: XmlNodeRef, tag: string): XmlNodeRef[] {
  const out: XmlNodeRef[] = [];
  const visit = (n: XmlNodeRef) => {
    if (n.tag === tag) out.push(n);
    for (const c of n.children) visit(c);
  };
  visit(node);
  return out;
}

export function findFirst(node: XmlNodeRef, tag: string): XmlNodeRef | null {
  if (node.tag === tag) return node;
  for (const c of node.children) {
    const found = findFirst(c, tag);
    if (found) return found;
  }
  return null;
}
