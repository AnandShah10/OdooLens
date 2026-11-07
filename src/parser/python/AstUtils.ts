import { SourceLocation } from '../../semantic/OdooTypes';

export type SyntaxNode = any;

export function loc(node: SyntaxNode, file: string): SourceLocation {
  return {
    file,
    startLine: node.startPosition.row,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row,
    endCol: node.endPosition.column,
  };
}

export function text(node: SyntaxNode): string {
  return node.text;
}

export function findChildByField(node: SyntaxNode, field: string): SyntaxNode | null {
  return node.childForFieldName ? node.childForFieldName(field) : null;
}

export function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren ?? [];
}

/** Depth-first walk over all descendant nodes (including the node itself). */
export function* walk(node: SyntaxNode): Generator<SyntaxNode> {
  yield node;
  for (const child of namedChildren(node)) {
    yield* walk(child);
  }
}

export function findAll(node: SyntaxNode, type: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (const n of walk(node)) {
    if (n.type === type) out.push(n);
  }
  return out;
}

/** Strips one layer of matching quotes from a Python string literal node's text. */
export function stringLiteralValue(node: SyntaxNode): string | null {
  if (!node) return null;
  if (node.type === 'string') {
    // tree-sitter-python represents strings as (string (string_start) (string_content)? (string_end))
    const contentNode = namedChildren(node).find((c: SyntaxNode) => c.type === 'string_content');
    if (contentNode) return contentNode.text;
    // Fallback: strip quotes manually.
    const raw: string = node.text;
    const m = raw.match(/^[rRbBfFuU]*(['"]{3}|['"])([\s\S]*)\1$/);
    return m ? m[2] : null;
  }
  return null;
}

/** Evaluates simple Python literals (str, number, bool, None, list, tuple, dict-of-literals) into JS values. */
export function evalLiteral(node: SyntaxNode): unknown {
  if (!node) return undefined;
  switch (node.type) {
    case 'string':
      return stringLiteralValue(node) ?? '';
    case 'integer':
      return parseInt(node.text, 10);
    case 'float':
      return parseFloat(node.text);
    case 'true':
      return true;
    case 'false':
      return false;
    case 'none':
      return null;
    case 'list':
    case 'tuple':
    case 'set':
      return namedChildren(node).map(evalLiteral);
    case 'dictionary': {
      const obj: Record<string, unknown> = {};
      for (const pair of namedChildren(node)) {
        if (pair.type !== 'pair') continue;
        const key = findChildByField(pair, 'key');
        const value = findChildByField(pair, 'value');
        const keyVal = key ? evalLiteral(key) : undefined;
        if (typeof keyVal === 'string') {
          obj[keyVal] = value ? evalLiteral(value) : undefined;
        }
      }
      return obj;
    }
    case 'unary_operator': {
      // handles e.g. -1
      const operand = namedChildren(node)[0];
      const val = evalLiteral(operand);
      if (typeof val === 'number' && node.text.trim().startsWith('-')) return -val;
      return val;
    }
    case 'parenthesized_expression':
      return evalLiteral(namedChildren(node)[0]);
    default:
      // Not a literal we can statically evaluate (e.g. a function call, name reference).
      return undefined;
  }
}

/** Returns the (possibly dotted) name of a call's callee, e.g. "self.env" or "fields.Many2one". */
export function calleeName(callNode: SyntaxNode): string | null {
  const fn = findChildByField(callNode, 'function');
  if (!fn) return null;
  return flattenAttributeOrIdentifier(fn);
}

export function flattenAttributeOrIdentifier(node: SyntaxNode): string | null {
  if (!node) return null;
  if (node.type === 'identifier') return node.text;
  if (node.type === 'attribute') {
    const obj = findChildByField(node, 'object');
    const attr = findChildByField(node, 'attribute');
    const objName = flattenAttributeOrIdentifier(obj);
    return objName ? `${objName}.${attr?.text ?? ''}` : attr?.text ?? null;
  }
  if (node.type === 'subscript') {
    // self.env['x'] -> treat base as "self.env" for name purposes; subscript key handled elsewhere.
    const value = findChildByField(node, 'value');
    return flattenAttributeOrIdentifier(value);
  }
  return null;
}

/** For a subscript node like self.env['sale.order'], returns 'sale.order' if the key is a string literal. */
export function subscriptStringKey(node: SyntaxNode): string | null {
  if (!node || node.type !== 'subscript') return null;
  const subscript = findChildByField(node, 'subscript');
  if (!subscript) return null;
  return stringLiteralValue(subscript);
}

export function argumentNodes(callNode: SyntaxNode): SyntaxNode[] {
  const argsList = findChildByField(callNode, 'arguments');
  if (!argsList) return [];
  return namedChildren(argsList).filter((n: SyntaxNode) => n.type !== 'comment');
}

export function keywordArgs(callNode: SyntaxNode): Map<string, SyntaxNode> {
  const map = new Map<string, SyntaxNode>();
  for (const arg of argumentNodes(callNode)) {
    if (arg.type === 'keyword_argument') {
      const name = findChildByField(arg, 'name');
      const value = findChildByField(arg, 'value');
      if (name && value) map.set(name.text, value);
    }
  }
  return map;
}

export function positionalArgs(callNode: SyntaxNode): SyntaxNode[] {
  return argumentNodes(callNode).filter((n: SyntaxNode) => n.type !== 'keyword_argument');
}

/** Determines whether `node` is lexically inside a for/while loop within the same function scope. */
export function isInsideLoop(node: SyntaxNode): boolean {
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'function_definition' || cur.type === 'lambda') return false;
    if (cur.type === 'for_statement' || cur.type === 'while_statement') return true;
    cur = cur.parent;
  }
  return false;
}

/** Counts how many for/while loops (within the same function scope) lexically enclose `node`. */
export function loopDepth(node: SyntaxNode): number {
  let depth = 0;
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'function_definition' || cur.type === 'lambda') break;
    if (cur.type === 'for_statement' || cur.type === 'while_statement') depth++;
    cur = cur.parent;
  }
  return depth;
}

export function enclosingFunctionDef(node: SyntaxNode): SyntaxNode | null {
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'function_definition') return cur;
    cur = cur.parent;
  }
  return null;
}

export function enclosingClassDef(node: SyntaxNode): SyntaxNode | null {
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'class_definition') return cur;
    cur = cur.parent;
  }
  return null;
}
