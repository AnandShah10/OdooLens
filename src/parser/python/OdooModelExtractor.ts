import { parsePython } from './TreeSitterPython';
import {
  SyntaxNode,
  calleeName,
  evalLiteral,
  findAll,
  findChildByField,
  flattenAttributeOrIdentifier,
  isInsideLoop,
  loopDepth,
  keywordArgs,
  loc,
  namedChildren,
  positionalArgs,
  stringLiteralValue,
  subscriptStringKey,
  text,
} from './AstUtils';
import {
  EnvAccessSite,
  RawVarBinding,
  RawAttributeChain,
  ChainRefShape,
  OdooDecorator,
  OdooFieldDecl,
  OdooMethodDecl,
  OdooModelContribution,
  OdooControllerContribution,
  OdooPythonImport,
  OrmCallSite,
  SourceLocation,
  normalizeInherit,
} from '../../semantic/OdooTypes';

const FIELD_MODULE_NAMES = new Set(['fields']);
const RELATIONAL_TYPES = new Set(['Many2one', 'One2many', 'Many2many']);
const ORM_METHODS = new Set([
  'search',
  'browse',
  'create',
  'write',
  'unlink',
  'search_count',
  'read',
  'mapped',
  'sudo',
  'search_read',
  'name_get',
  'filtered',
  'filtered_domain',
  'sorted',
]);

export interface PythonFileAnalysis {
  file: string;
  modelContributions: OdooModelContribution[];
  controllerContributions: OdooControllerContribution[];
  /** Top-level import / from-import statements (for dead-code unused-import analysis). */
  imports: OdooPythonImport[];
  parseError?: string;
}

/**
 * Parses a single Python file and extracts every `class X(models.Model)` (or
 * TransientModel/AbstractModel) contribution found in it, including fields, methods,
 * decorators, and ORM call sites (for the performance/security analyzers) — plus, separately,
 * every `class X(http.Controller)` contribution, since its `@http.route`-decorated methods are
 * exactly what the security analyzer's auth-aware checks need and are NOT Odoo model classes
 * (no `_name`, no fields), so they're kept in their own list rather than model contributions.
 */
export async function extractOdooModels(
  filePath: string,
  source: string,
  module: string,
  extensionRoot: string
): Promise<PythonFileAnalysis> {
  try {
    const { tree } = await parsePython(source, extensionRoot);
    const classes = findAll(tree.rootNode, 'class_definition');
    const contributions: OdooModelContribution[] = [];
    const controllerContributions: OdooControllerContribution[] = [];

    for (const cls of classes) {
      if (isOdooModelClass(cls)) {
        contributions.push(buildContribution(cls, filePath, module));
      } else if (isControllerClass(cls)) {
        controllerContributions.push(buildControllerContribution(cls, filePath, module));
      }
    }
    const imports = collectImports(tree.rootNode, filePath);
    return { file: filePath, modelContributions: contributions, controllerContributions, imports };
  } catch (err: any) {
    return { file: filePath, modelContributions: [], controllerContributions: [], imports: [], parseError: String(err?.message ?? err) };
  }
}

function isControllerClass(cls: SyntaxNode): boolean {
  const superclasses = findChildByField(cls, 'superclasses');
  if (!superclasses) return false;
  for (const arg of namedChildren(superclasses)) {
    const name = flattenAttributeOrIdentifier(arg);
    if (name && (name === 'http.Controller' || name === 'Controller' || name.endsWith('.Controller'))) return true;
  }
  return false;
}

function buildControllerContribution(cls: SyntaxNode, filePath: string, module: string): OdooControllerContribution {
  const className = findChildByField(cls, 'name')?.text ?? '<anonymous>';
  const body = findChildByField(cls, 'body');
  const methods: OdooMethodDecl[] = [];
  // Reuse the exact same field/method extraction path as a model contribution, but discard the
  // (meaningless, for a controller) field/inherit results — this keeps decorator/ORM-call/
  // attribute-chain extraction logic in exactly one place rather than duplicating it.
  const pseudoContribution: OdooModelContribution = {
    className,
    inherit: [],
    inherits: {},
    fields: [],
    methods: [],
    module,
    location: loc(cls, filePath),
    baseClass: 'Model',
    inheritLocations: [],
  };

  if (body) {
    for (const stmt of namedChildren(body)) {
      if (stmt.type === 'decorated_definition') {
        const inner = namedChildren(stmt).find((n: SyntaxNode) => n.type === 'function_definition');
        if (inner) {
          const decorators = namedChildren(stmt)
            .filter((n: SyntaxNode) => n.type === 'decorator')
            .map((n: SyntaxNode) => parseDecorator(n, filePath));
          methods.push(buildMethod(inner, decorators, pseudoContribution, filePath, module));
        }
      } else if (stmt.type === 'function_definition') {
        methods.push(buildMethod(stmt, [], pseudoContribution, filePath, module));
      }
    }
  }

  return { className, methods, module, location: loc(cls, filePath) };
}

function detectBaseClass(cls: SyntaxNode): 'Model' | 'TransientModel' | 'AbstractModel' {
  const superclasses = findChildByField(cls, 'superclasses');
  if (!superclasses) return 'Model';
  for (const arg of namedChildren(superclasses)) {
    const name = flattenAttributeOrIdentifier(arg);
    if (name && (name === 'models.TransientModel' || name.endsWith('.TransientModel'))) return 'TransientModel';
    if (name && (name === 'models.AbstractModel' || name.endsWith('.AbstractModel'))) return 'AbstractModel';
  }
  return 'Model';
}

function isOdooModelClass(cls: SyntaxNode): boolean {
  const superclasses = findChildByField(cls, 'superclasses');
  if (!superclasses) return false;
  for (const arg of namedChildren(superclasses)) {
    const name = flattenAttributeOrIdentifier(arg);
    if (
      name &&
      (name === 'models.Model' ||
        name === 'models.TransientModel' ||
        name === 'models.AbstractModel' ||
        name.endsWith('.Model') ||
        name.endsWith('.TransientModel') ||
        name.endsWith('.AbstractModel'))
    ) {
      return true;
    }
  }
  return false;
}

function buildContribution(cls: SyntaxNode, filePath: string, module: string): OdooModelContribution {
  const className = findChildByField(cls, 'name')?.text ?? '<anonymous>';
  const body = findChildByField(cls, 'body');
  const contribution: OdooModelContribution = {
    className,
    inherit: [],
    inherits: {},
    fields: [],
    methods: [],
    module,
    location: loc(cls, filePath),
    baseClass: detectBaseClass(cls),
    inheritLocations: [],
  };

  if (!body) return contribution;

  for (const stmt of namedChildren(body)) {
    if (stmt.type === 'expression_statement') {
      const assign = namedChildren(stmt)[0];
      if (assign && assign.type === 'assignment') {
        handleClassLevelAssignment(assign, contribution, filePath, module);
      }
    } else if (stmt.type === 'decorated_definition') {
      const inner = namedChildren(stmt).find((n: SyntaxNode) => n.type === 'function_definition');
      if (inner) {
        const decorators = namedChildren(stmt)
          .filter((n: SyntaxNode) => n.type === 'decorator')
          .map((n: SyntaxNode) => parseDecorator(n, filePath));
        contribution.methods.push(buildMethod(inner, decorators, contribution, filePath, module));
      }
    } else if (stmt.type === 'function_definition') {
      contribution.methods.push(buildMethod(stmt, [], contribution, filePath, module));
    }
  }

  // Second pass: mark compute methods and propagate @api.depends() paths onto the field(s) they compute.
  const methodsByName = new Map(contribution.methods.map((m) => [m.name, m] as const));
  for (const field of contribution.fields) {
    if (!field.compute) continue;
    const method = methodsByName.get(field.compute);
    if (!method) continue;
    method.isCompute = true;
    const dependsDecorator = method.decorators.find((d) => d.name === 'api.depends' || d.name === 'depends');
    if (dependsDecorator) {
      field.dependsOn = Array.from(new Set([...field.dependsOn, ...dependsDecorator.args]));
    }
  }

  return contribution;
}

/** Location of just a string literal's CONTENT (excluding the surrounding quotes) — used for
 *  `_name`/`_inherit` so a rename edit replaces exactly `old.model`, not `"old.model"`. */
function stringContentLoc(node: SyntaxNode, filePath: string): SourceLocation {
  const contentNode = namedChildren(node).find((c: SyntaxNode) => c.type === 'string_content');
  return contentNode ? loc(contentNode, filePath) : loc(node, filePath);
}

function handleClassLevelAssignment(
  assign: SyntaxNode,
  contribution: OdooModelContribution,
  filePath: string,
  module: string
): void {
  const left = findChildByField(assign, 'left');
  const right = findChildByField(assign, 'right');
  if (!left || !right) return;
  const leftName = left.type === 'identifier' ? left.text : null;

  if (leftName === '_name') {
    contribution.name = (stringLiteralValue(right) ?? undefined) as string | undefined;
    if (right.type === 'string' && contribution.name) {
      contribution.nameLocation = stringContentLoc(right, filePath);
    }
    return;
  }
  if (leftName === '_inherit') {
    if (right.type === 'string') {
      const val = stringLiteralValue(right);
      if (val) {
        contribution.inherit = [val];
        contribution.inheritLocations = [stringContentLoc(right, filePath)];
      }
    } else if (right.type === 'list' || right.type === 'tuple') {
      const inherit: string[] = [];
      const locations: SourceLocation[] = [];
      for (const child of namedChildren(right)) {
        if (child.type !== 'string') continue;
        const val = stringLiteralValue(child);
        if (val) {
          inherit.push(val);
          locations.push(stringContentLoc(child, filePath));
        }
      }
      contribution.inherit = inherit;
      contribution.inheritLocations = locations;
    } else {
      // A non-literal expression (e.g. computed dynamically) — we can still know the resulting
      // model names via evalLiteral in the common cases it handles, but there is no source
      // location to safely rename, so inheritLocations stays empty for this contribution.
      contribution.inherit = normalizeInherit(evalLiteral(right));
    }
    return;
  }
  if (leftName === '_inherits') {
    const val = evalLiteral(right);
    if (val && typeof val === 'object') contribution.inherits = val as Record<string, string>;
    return;
  }
  if (leftName === '_description') {
    contribution.description = (stringLiteralValue(right) ?? undefined) as string | undefined;
    return;
  }

  // Field declaration: `name = fields.Char(...)`.
  if (leftName && right.type === 'call') {
    const callee = calleeName(right);
    if (callee && FIELD_MODULE_NAMES.has(callee.split('.')[0]) && callee.includes('.')) {
      const fieldType = callee.split('.')[1];
      contribution.fields.push(buildField(leftName, fieldType, right, left, contribution, filePath, module));
    }
  }
}

function buildField(
  fieldName: string,
  fieldType: string,
  callNode: SyntaxNode,
  nameNode: SyntaxNode,
  contribution: OdooModelContribution,
  filePath: string,
  module: string
): OdooFieldDecl {
  const kwargs = keywordArgs(callNode);
  const positional = positionalArgs(callNode);

  const field: OdooFieldDecl = {
    name: fieldName,
    fieldType,
    dependsOn: [],
    model: contribution.name ?? contribution.inherit[0] ?? contribution.className,
    module,
    location: loc(callNode, filePath),
    nameLocation: loc(nameNode, filePath),
  };

  if (RELATIONAL_TYPES.has(fieldType) && positional.length > 0) {
    field.comodel = (stringLiteralValue(positional[0]) ?? undefined) as string | undefined;
    if (fieldType === 'One2many' && positional.length > 1) {
      field.inverseField = (stringLiteralValue(positional[1]) ?? undefined) as string | undefined;
    }
  }
  if (kwargs.has('comodel_name')) field.comodel = stringLiteralValue(kwargs.get('comodel_name')!) ?? field.comodel;
  if (kwargs.has('inverse_name')) field.inverseField = stringLiteralValue(kwargs.get('inverse_name')!) ?? field.inverseField;
  if (kwargs.has('relation')) field.relationTable = stringLiteralValue(kwargs.get('relation')!) ?? undefined;
  if (kwargs.has('compute')) field.compute = stringLiteralValue(kwargs.get('compute')!) ?? undefined;
  if (kwargs.has('inverse')) field.inverse = stringLiteralValue(kwargs.get('inverse')!) ?? undefined;
  if (kwargs.has('search')) field.search = stringLiteralValue(kwargs.get('search')!) ?? undefined;
  if (kwargs.has('related')) {
    const relatedNode = kwargs.get('related')!;
    field.related = stringLiteralValue(relatedNode) ?? undefined;
    if (field.related && relatedNode.type === 'string') {
      field.relatedLocation = stringContentLoc(relatedNode, filePath);
    }
  }
  if (kwargs.has('store')) field.store = Boolean(evalLiteral(kwargs.get('store')!));
  if (kwargs.has('readonly')) field.readonly = Boolean(evalLiteral(kwargs.get('readonly')!));
  if (kwargs.has('required')) field.required = Boolean(evalLiteral(kwargs.get('required')!));
  if (kwargs.has('default')) field.default = text(kwargs.get('default')!);
  if (kwargs.has('domain')) field.domain = text(kwargs.get('domain')!);

  if (field.related) {
    field.dependsOn = [field.related];
  }

  return field;
}

function parseDecorator(decNode: SyntaxNode, filePath: string): OdooDecorator {
  // decorator := '@' (identifier | attribute | call)
  const inner = namedChildren(decNode)[0];
  let name = '';
  let args: string[] = [];
  const argLocations: SourceLocation[] = [];
  let kwargs: Record<string, string> = {};
  if (inner?.type === 'call') {
    name = flattenAttributeOrIdentifier(findChildByField(inner, 'function')) ?? '';
    for (const a of positionalArgs(inner)) {
      const val = stringLiteralValue(a);
      if (val !== null) {
        args.push(val);
        // Prefer content-only location so rename replaces `partner_id` not `'partner_id'`.
        argLocations.push(a.type === 'string' ? stringContentLoc(a, filePath) : loc(a, filePath));
      }
    }
    for (const [key, valueNode] of keywordArgs(inner)) {
      const literal = evalLiteral(valueNode);
      if (literal !== undefined && literal !== null && typeof literal !== 'object') {
        kwargs[key] = String(literal);
      } else if (typeof literal === 'object' && Array.isArray(literal)) {
        // e.g. methods=['GET', 'POST'] — flatten to a comma-separated string for display/matching.
        kwargs[key] = literal.filter((v) => typeof v === 'string').join(',');
      }
    }
  } else {
    name = flattenAttributeOrIdentifier(inner) ?? '';
  }
  return { name, args, argLocations: argLocations.length ? argLocations : undefined, kwargs };
}

/**
 * Captures every local-variable binding in a method body in its RAW, unresolved shape (see
 * `RawVarBinding` in semantic/OdooTypes.ts for why resolution is deferred). Handles direct
 * `self.env[...]` lookups, `var = self`, `var = otherVar` copies, and all three `for x in ...:`
 * shapes (`for x in self:`, `for x in otherVar:`, `for x in otherVar.some_field:`). Does NOT
 * handle a for-loop iterable that's itself a deeper chain (`for x in a.b.c:`) or a reassignment
 * that changes a variable's type via a method call (`var = var.mapped(...)`) — both are
 * documented, deliberate stopping points rather than silent guesses.
 */
function collectVarBindings(fnNode: SyntaxNode): RawVarBinding[] {
  const bindings: RawVarBinding[] = [];

  for (const assign of findAll(fnNode, 'assignment')) {
    const left = findChildByField(assign, 'left');
    const right = findChildByField(assign, 'right');
    if (!left || !right || left.type !== 'identifier') continue;
    const varName = left.text;
    if (varName === 'self') continue;

    if (right.type === 'identifier') {
      bindings.push({ varName, source: right.text === 'self' ? { kind: 'self' } : { kind: 'copyVar', fromVar: right.text } });
      continue;
    }
    if (right.type === 'call') {
      const fn = findChildByField(right, 'function');
      const objectNode = fn ? findChildByField(fn, 'object') : null;
      const methodName = fn ? findChildByField(fn, 'attribute')?.text : null;
      if (objectNode?.type === 'subscript' && methodName && ORM_METHODS.has(methodName)) {
        const model = subscriptStringKey(objectNode);
        if (model) bindings.push({ varName, source: { kind: 'envLookup', model } });
        continue;
      }
      const shape = describeChainRefShape(right);
      if (shape) bindings.push({ varName, source: { kind: 'chainRef', ...shape } });
      continue;
    }
    if (right.type === 'attribute') {
      // `partner = self.partner_id` — very common in Odoo code. The variable's eventual type
      // is whatever comodel the chain resolves to; see RawVarBindingSource's 'chainRef' docs.
      const shape = describeChainRefShape(right);
      if (shape) bindings.push({ varName, source: { kind: 'chainRef', ...shape } });
    }
  }

  for (const forStmt of findAll(fnNode, 'for_statement')) {
    const target = findChildByField(forStmt, 'left');
    const iterable = findChildByField(forStmt, 'right');
    if (!target || target.type !== 'identifier' || !iterable) continue;
    const varName = target.text;

    if (iterable.type === 'identifier') {
      bindings.push({
        varName,
        source: iterable.text === 'self' ? { kind: 'forLoopOverSelf' } : { kind: 'forLoopOverVar', fromVar: iterable.text },
      });
      continue;
    }
    // Handles both `for x in a.b.c:` (a multi-segment chain, not just one attribute hop) and
    // `for x in a.b.filtered(...):` (a chain followed by a type-preserving method call).
    const shape = describeChainRefShape(iterable);
    if (shape) bindings.push({ varName, source: { kind: 'forLoopOverChain', ...shape } });
  }

  return bindings;
}

// Recordset methods that are known, by Odoo's documented API, to return the SAME model as the
// recordset they were called on — so `partner.child_ids.filtered(...)` is still `res.partner`.
// Deliberately excludes anything whose return type depends on its arguments (e.g. `read()`,
// `mapped()` without special-casing below) or isn't a recordset at all (`ids`, `name_get()`).
// `search`/`browse` here mean "called directly on an already-resolved recordset/self"
// (`self.search([...])`), which Odoo's ORM defines as searching/browsing within that same
// model — a DIFFERENT call shape from `self.env['x'].search(...)`, which is handled separately
// as `envLookup` and can target any model, not just the caller's own.
const TYPE_PRESERVING_METHODS = new Set([
  'filtered',
  'filtered_domain',
  'sorted',
  'exists',
  'with_context',
  'with_user',
  'with_company',
  'sudo',
  'browse',
  'ensure_one',
  'copy',
  'search',
]);

/** Decomposes a plain identifier or attribute-chain expression into {baseRef, fields}, with no
 *  trailing method — the shared first step for both `describeChainRefShape` and chain
 *  extraction elsewhere. Returns null for anything else (subscripts, literals, ...). */
function decomposeToBaseAndFields(node: SyntaxNode): { baseRef: string; fields: string[] } | null {
  if (node.type === 'identifier') return { baseRef: node.text, fields: [] };
  if (node.type === 'attribute') {
    const decomposed = decomposeAttributeChain(node);
    if (!decomposed) return null;
    return { baseRef: decomposed.base.text, fields: decomposed.segments.map((s) => s.name) };
  }
  return null;
}

/**
 * Describes an expression as a `ChainRefShape` — a base + field chain, optionally followed by a
 * SEQUENCE of type-transforming method calls (unwound from the outside in, then replayed in
 * left-to-right order). Handles:
 *   - `a`, `a.b`, `a.b.c`                                    (plain chain, any length)
 *   - `a.b.c.filtered(...)` / `.sorted(...)` / ...            (chain + one known method)
 *   - `a.b.filtered(...).sorted(...).mapped('child_ids')`     (chain + ANY NUMBER of them, chained)
 *   - `a.b.mapped('some_field')`                              (chain + mapped, single field arg)
 * If ANY method anywhere in the sequence is unrecognized (or `mapped()` has a dotted/non-literal
 * argument), the WHOLE expression returns null — not a partial result up to that point — since a
 * later, unknown transform could change the type in a way earlier segments can't predict.
 */
function describeChainRefShape(node: SyntaxNode): ChainRefShape | null {
  const trailingMethods: { name: string; arg?: string }[] = [];
  let current = node;

  while (current.type === 'call') {
    const fn = findChildByField(current, 'function');
    if (!fn) return null;
    const objectNode = findChildByField(fn, 'object');
    const methodName = findChildByField(fn, 'attribute')?.text;
    if (!objectNode || !methodName) return null;

    if (TYPE_PRESERVING_METHODS.has(methodName)) {
      trailingMethods.unshift({ name: methodName });
      current = objectNode;
      continue;
    }
    if (methodName === 'mapped') {
      const positional = positionalArgs(current);
      if (positional.length === 1) {
        const argVal = stringLiteralValue(positional[0]);
        if (argVal && !argVal.includes('.')) {
          trailingMethods.unshift({ name: 'mapped', arg: argVal });
          current = objectNode;
          continue;
        }
      }
      return null;
    }
    return null; // an unrecognized method anywhere in the sequence invalidates the whole chain
  }

  const base = decomposeToBaseAndFields(current);
  if (!base) return null;
  return { ...base, trailingMethods };
}

/** Decomposes a (possibly nested) `attribute` node into its base identifier and ordered segment
 *  list, e.g. `order.partner_id.name` -> { base: order, segments: [partner_id, name] }. Returns
 *  null if the chain doesn't bottom out at a plain identifier (e.g. `self.mapped(...)[0].name`
 *  bottoms out at a subscript, not an identifier) — such chains are simply not tracked. */
function decomposeAttributeChain(node: SyntaxNode): { base: SyntaxNode; segments: { name: string; node: SyntaxNode }[] } | null {
  const segments: { name: string; node: SyntaxNode }[] = [];
  let current = node;
  while (current.type === 'attribute') {
    const attr = findChildByField(current, 'attribute');
    const obj = findChildByField(current, 'object');
    if (!attr || !obj) return null;
    // Store the identifier node (attr) so location points at the exact field name text,
    // enabling safe automated rename of Python attribute usages.
    segments.unshift({ name: attr.text, node: attr });
    current = obj;
  }
  if (current.type !== 'identifier') return null;
  return { base: current, segments };
}

/** True when `node` is NOT itself nested as the `object` of an enclosing `attribute` node — i.e.
 *  it's the full, maximal chain expression, not a prefix of a longer one. Compares by
 *  `startIndex`/`endIndex` rather than `===`, since web-tree-sitter can hand back a different JS
 *  wrapper object for the same underlying node depending on the access path (see the node
 *  identity note in ARCHITECTURE.md). */
function isMaximalAttributeChain(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent || parent.type !== 'attribute') return true;
  const obj = findChildByField(parent, 'object');
  return !(obj && obj.startIndex === node.startIndex && obj.endIndex === node.endIndex);
}

/**
 * Captures every maximal attribute-access chain in a method body in RAW, unresolved form — e.g.
 * `order.partner_id.name` becomes `{ baseRef: 'order', segments: [partner_id, name] }`. Whether
 * `order` actually resolves to a model, and whether `partner_id` is a relational field whose
 * comodel lets the chain continue to `name`, is decided later by `AttributeChainResolver.ts`
 * once the fully-merged model index is available — extraction alone can't answer that.
 *
 * When the maximal chain is itself a call's callee (`order.order_line.mapped(...)`) or the
 * object of a subscript (`self.env['x']`), the trailing segment (`mapped`, `env`) is dropped —
 * it's a method/registry lookup, not a field — but earlier segments in the same chain are kept
 * (so `order_line` above is still captured).
 */
function collectAttributeChains(fnNode: SyntaxNode, filePath: string): RawAttributeChain[] {
  const chains: RawAttributeChain[] = [];

  for (const node of findAll(fnNode, 'attribute')) {
    if (!isMaximalAttributeChain(node)) continue;
    const decomposed = decomposeAttributeChain(node);
    if (!decomposed || decomposed.segments.length === 0) continue;

    let segments = decomposed.segments;
    const parent = node.parent;
    if (parent?.type === 'call') {
      const fn = findChildByField(parent, 'function');
      if (fn && fn.startIndex === node.startIndex && fn.endIndex === node.endIndex) {
        segments = segments.slice(0, -1); // trailing method name, not a field
      }
    } else if (parent?.type === 'subscript') {
      const value = findChildByField(parent, 'value');
      if (value && value.startIndex === node.startIndex && value.endIndex === node.endIndex) {
        segments = segments.slice(0, -1); // trailing registry-lookup key (e.g. `env`)
      }
    }
    if (segments.length === 0) continue;

    chains.push({
      baseRef: decomposed.base.text,
      segments: segments.map((s) => ({ field: s.name, location: loc(s.node, filePath) })),
    });
  }

  return chains;
}

function buildMethod(
  fnNode: SyntaxNode,
  decorators: OdooDecorator[],
  contribution: OdooModelContribution,
  filePath: string,
  module: string
): OdooMethodDecl {
  const nameNode = findChildByField(fnNode, 'name');
  const name = nameNode?.text ?? '<anonymous>';
  const nameLocation = nameNode ? loc(nameNode, filePath) : loc(fnNode, filePath);

  const ormCalls: OrmCallSite[] = [];
  const calledMethods = new Set<string>();
  const calledMethodSites: { name: string; location: SourceLocation }[] = [];
  const calleeNames = new Set<string>();
  const envAccesses: EnvAccessSite[] = [];

  // Bare `self.env['model']` accesses, tracked independently of whether they're chained into
  // an ORM method call, so the "repeated env access" rule can catch e.g. three separate
  // `self.env['x'].browse(...)`/`self.env['x'].create(...)` calls that never share a call site.
  for (const subscript of findAll(fnNode, 'subscript')) {
    const value = findChildByField(subscript, 'value');
    if (flattenAttributeOrIdentifier(value) === 'self.env') {
      const model = subscriptStringKey(subscript);
      const keyNode = findChildByField(subscript, 'subscript');
      if (model && keyNode) {
        envAccesses.push({ model, location: loc(subscript, filePath), keyLocation: stringContentLoc(keyNode, filePath) });
      }
    }
  }

  for (const call of findAll(fnNode, 'call')) {
    const callee = calleeName(call);
    if (!callee) continue;

    // self.xxx(...) direct method calls, for impact analysis + rename/references.
    const selfMatch = callee.match(/^self\.([A-Za-z_][A-Za-z0-9_]*)$/);
    if (selfMatch) {
      calledMethods.add(selfMatch[1]);
      // Prefer the attribute identifier node (exact name span) when the callee is an attribute.
      const fnNodeCalleeForSelf = findChildByField(call, 'function');
      const attrNode = fnNodeCalleeForSelf ? findChildByField(fnNodeCalleeForSelf, 'attribute') : null;
      calledMethodSites.push({
        name: selfMatch[1],
        location: attrNode ? loc(attrNode, filePath) : loc(call, filePath),
      });
    }

    const parts = callee.split('.');
    const lastSegment = parts[parts.length - 1];
    calleeNames.add(lastSegment);
    if (ORM_METHODS.has(lastSegment)) {
      const base = parts.slice(0, -1).join('.');
      let targetModel: string | undefined;
      const fnNodeCallee = findChildByField(call, 'function');
      const objectNode = fnNodeCallee ? findChildByField(fnNodeCallee, 'object') : null;
      if (objectNode && objectNode.type === 'subscript') {
        const key = subscriptStringKey(objectNode);
        if (key) targetModel = key;
      } else if (base === 'self') {
        targetModel = contribution.name ?? contribution.inherit[0];
      }
      ormCalls.push({
        method: lastSegment,
        location: loc(call, filePath),
        insideLoop: isInsideLoop(call),
        loopDepth: loopDepth(call),
        targetModel,
        rawText: text(call).slice(0, 200),
      });
    }
  }

  return {
    name,
    decorators,
    isCompute: false,
    model: contribution.name ?? contribution.inherit[0] ?? contribution.className,
    module,
    location: loc(fnNode, filePath),
    calledMethods: Array.from(calledMethods),
    calledMethodSites,
    calleeNames: Array.from(calleeNames),
    ormCalls,
    envAccesses,
    varBindings: collectVarBindings(fnNode),
    attributeChains: collectAttributeChains(fnNode, filePath),
    nameLocation,
  };
}


/** Collect top-level `import x` / `from x import y` statements with source locations. */
function collectImports(root: SyntaxNode, filePath: string): OdooPythonImport[] {
  const out: OdooPythonImport[] = [];
  // Only module-level statements (direct children of the module node), not nested imports.
  const body = root.type === 'module' ? namedChildren(root) : namedChildren(root);
  for (const stmt of body) {
    if (stmt.type === 'import_statement') {
      // import a, b as c
      for (const child of namedChildren(stmt)) {
        if (child.type === 'dotted_name' || child.type === 'aliased_import') {
          const nameNode = child.type === 'aliased_import' ? namedChildren(child)[0] : child;
          const mod = nameNode?.text ?? child.text;
          out.push({ module: mod, names: [], isRelative: false, location: loc(child, filePath) });
        }
      }
    } else if (stmt.type === 'import_from_statement') {
      // from .foo import bar, baz  /  from odoo import models, fields
      let moduleName = '';
      let isRelative = false;
      const names: string[] = [];
      // tree-sitter-python: module_name field, and dotted_name / relative_import children
      const modField = findChildByField(stmt, 'module_name');
      if (modField) {
        moduleName = modField.text;
        isRelative = moduleName.startsWith('.') || modField.type === 'relative_import';
      } else {
        // relative_import node may appear as a child
        for (const c of namedChildren(stmt)) {
          if (c.type === 'relative_import' || c.type === 'dotted_name') {
            if (!moduleName && c.type === 'relative_import') {
              moduleName = c.text;
              isRelative = true;
            } else if (!moduleName && c.type === 'dotted_name') {
              moduleName = c.text;
            }
          }
        }
      }
      for (const c of namedChildren(stmt)) {
        if (c.type === 'dotted_name' && c !== modField && c.text !== moduleName) {
          names.push(c.text);
        } else if (c.type === 'aliased_import') {
          const n = namedChildren(c)[0];
          if (n) names.push(n.text);
        } else if (c.type === 'identifier' && c.text !== moduleName) {
          names.push(c.text);
        }
      }
      // Wildcard
      if (stmt.text.includes(' import *')) names.push('*');
      out.push({
        module: moduleName || '.',
        names,
        isRelative,
        location: loc(stmt, filePath),
      });
    }
  }
  return out;
}
