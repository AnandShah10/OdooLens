/**
 * Framework-independent semantic types describing the Odoo domain model.
 * Nothing in this file may import from `vscode`.
 */

export interface SourceLocation {
  file: string; // absolute path
  startLine: number; // 0-based
  startCol: number;
  endLine: number;
  endCol: number;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface OdooFieldDecl {
  name: string;
  fieldType: string; // e.g. Char, Many2one, One2many, Monetary...
  comodel?: string; // for relational fields
  inverseField?: string; // for One2many
  relationTable?: string; // for Many2many
  compute?: string;
  inverse?: string;
  search?: string;
  related?: string;
  /** Location of the `related='...'` string contents when present (for safe rename of the path). */
  relatedLocation?: SourceLocation;
  store?: boolean;
  readonly?: boolean;
  required?: boolean;
  dependsOn: string[]; // from @api.depends on the compute method, or `related` path
  domain?: string; // raw source text of the domain, best-effort
  default?: string; // raw source text
  model: string; // owning model _name at declaration site
  module: string; // owning module
  location: SourceLocation; // the full `name = fields.X(...)` assignment/call expression
  nameLocation: SourceLocation; // just the `name` identifier on the left-hand side (for safe rename)
}

export interface OdooDecorator {
  name: string; // 'api.depends', 'api.onchange', 'api.constrains', 'api.model', etc.
  args: string[]; // raw positional string args, e.g. field paths for depends, or the route path(s)
  /** Parallel to `args`: source location of each string-literal argument's *contents*
   *  (quotes excluded). Absent or shorter than `args` when an arg was non-string / unevaluable.
   *  Enables safe rename of `@api.depends('field')` paths. */
  argLocations?: SourceLocation[];
  /** Keyword arguments with a literal value we could statically evaluate (string/bool/number),
   *  e.g. `@http.route(..., auth='public', csrf=False)` -> {auth:'public', csrf:'False'}. Values
   *  are stringified for simplicity since callers only ever compare/display them. */
  kwargs: Record<string, string>;
}

export interface OdooMethodDecl {
  name: string;
  decorators: OdooDecorator[];
  isCompute: boolean; // referenced by some field's compute=
  model: string;
  module: string;
  location: SourceLocation;
  calledMethods: string[]; // best-effort static list of `self.xxx(...)` calls found in body
  /** Exact locations of `self.xxx(...)` call-site method *names* (the `xxx` identifier), for
   *  rename + Find All References. */
  calledMethodSites?: { name: string; location: SourceLocation }[];
  /** The final name segment of EVERY call in the body (`self.env.user.has_group(...)` ->
   *  `has_group`), deduplicated. Unlike `calledMethods` (only `self.x()`) and `ormCalls` (only
   *  known ORM verbs), this answers "does this method call anything named X at all" — what
   *  checks like "does it call any access-check function" need. */
  calleeNames: string[];
  ormCalls: OrmCallSite[];
  envAccesses: EnvAccessSite[];
  varBindings: RawVarBinding[];
  attributeChains: RawAttributeChain[];
  docstring?: string;
  /** Just the `name` identifier of `def name(...)` (for safe rename) — `location` above spans
   *  the whole function including its body. */
  nameLocation: SourceLocation;
}

export interface OrmCallSite {
  method: 'search' | 'browse' | 'create' | 'write' | 'unlink' | 'search_count' | 'read' | 'mapped' | 'sudo' | 'search_read' | 'name_get' | string;
  location: SourceLocation;
  insideLoop: boolean;
  /** Number of for/while loops (within the same function) lexically enclosing this call. 0 = not in a loop. */
  loopDepth: number;
  targetModel?: string; // resolved from self.env['x'] where statically determinable
  rawText: string;
}

/** A bare `self.env['model']` access, tracked independently of whether it's chained into an ORM call. */
export interface EnvAccessSite {
  model: string;
  /** Location of the whole `self.env['model']` subscript expression. */
  location: SourceLocation;
  /** Location of just the `model` string's CONTENT (excluding quotes/brackets) — for safe
   *  rename, so an edit replaces exactly `old.model`, not `self.env['old.model']`. */
  keyLocation: SourceLocation;
}

/**
 * A raw (unresolved) local variable binding discovered syntactically within a single method
 * body. Resolving `source` into an actual model requires the fully-merged model index (to look
 * up a field's comodel for `chainRef`/`forLoopOverChain`), which isn't available yet during
 * single-file extraction — so extraction only captures the raw shape, and
 * `index/AttributeChainResolver.ts` resolves it afterward, once the whole workspace's models
 * are merged. `chainRef` covers `partner = self.partner_id` (and, with `trailingMethods`,
 * `active = partner.child_ids.filtered(...)`); `forLoopOverChain` covers the same shapes when
 * they appear as a for-loop iterable instead of an assignment's right-hand side, e.g.
 * `for child in partner.child_ids.filtered(...):`.
 */
/**
 * A chain of field accesses off some base expression, optionally followed by a SEQUENCE of
 * type-transforming method calls — e.g. `self.partner_id` is `{baseRef:'self', fields:
 * ['partner_id'], trailingMethods:[]}`, and `partner.child_ids.filtered(...).sorted(...)` is
 * `{baseRef:'partner', fields:['child_ids'], trailingMethods:[{name:'filtered'},{name:'sorted'}]}`.
 * Each entry in `trailingMethods` must be a known type-preserving recordset method
 * (filtered/sorted/exists/sudo/with_context/browse/copy/search/...) or `mapped` with a single
 * non-dotted field-name string argument — if ANY method in the sequence isn't recognized, the
 * whole shape is discarded (not partially resolved) rather than guessing past it. See
 * `AttributeChainResolver.ts` for the whitelist and exactly how each is resolved.
 */
export interface ChainRefShape {
  baseRef: string;
  fields: string[];
  trailingMethods: { name: string; arg?: string }[];
}

export type RawVarBindingSource =
  | { kind: 'self' }
  | { kind: 'envLookup'; model: string }
  | { kind: 'copyVar'; fromVar: string }
  | ({ kind: 'chainRef' } & ChainRefShape)
  | { kind: 'forLoopOverSelf' }
  | { kind: 'forLoopOverVar'; fromVar: string }
  | ({ kind: 'forLoopOverChain' } & ChainRefShape);

export interface RawVarBinding {
  varName: string;
  source: RawVarBindingSource;
}

export interface RawAttributeChainSegment {
  field: string;
  location: SourceLocation;
}

/**
 * A raw (unresolved) attribute-access chain such as `order.partner_id.name`, captured as
 * `{ baseRef: 'order', segments: [{field:'partner_id'}, {field:'name'}] }`. `baseRef` is either
 * the literal string `'self'` or a variable name resolved against the method's `varBindings`.
 * Like `RawVarBinding`, this is deliberately left unresolved at extraction time — walking past
 * the first segment requires knowing each field's comodel from the fully-merged model index.
 * See `AttributeChainResolver.ts` for how chains are walked and where they're allowed to stop.
 */
export interface RawAttributeChain {
  baseRef: string;
  segments: RawAttributeChainSegment[];
}

export interface OdooControllerRoute {
  path: string[];
  auth?: string;
  methods?: string[];
  location: SourceLocation;
  methodName: string;
  module: string;
}

/** A single class-level contribution (one `class X(models.Model)` block) to a logical model. */
export interface OdooModelContribution {
  className: string;
  name?: string; // _name
  inherit: string[]; // _inherit, normalized to a list (string or list in source)
  inherits: Record<string, string>; // _inherits = {model: field}
  description?: string;
  fields: OdooFieldDecl[];
  methods: OdooMethodDecl[];
  module: string;
  location: SourceLocation;
  /** Which of models.Model/TransientModel/AbstractModel this class extended, when determinable
   *  from the superclass expression. 'Model' is the default assumption if for some reason it
   *  can't be determined (e.g. an aliased import), since that's by far the common case. */
  baseClass: 'Model' | 'TransientModel' | 'AbstractModel';
  /** Location of just the `_name = "..."` string literal's contents (for safe rename), when
   *  this contribution declares `_name`. */
  nameLocation?: SourceLocation;
  /** Location of each `_inherit` string literal's contents, in the same order as `inherit` (for
   *  safe rename) — `_inherit` can be a single string or a list of strings in source. */
  inheritLocations: SourceLocation[];
}

/** The fully merged, post-inheritance view of an Odoo model. */
export interface OdooModel {
  name: string; // _name (the logical model identifier, e.g. "sale.order")
  contributions: OdooModelContribution[]; // in resolution order
  fields: Map<string, OdooFieldDecl>; // last-writer-wins merged fields, with history preserved on the decl chain via fieldHistory
  fieldHistory: Map<string, OdooFieldDecl[]>;
  methods: Map<string, OdooMethodDecl>;
  methodHistory: Map<string, OdooMethodDecl[]>;
  inheritsDelegated: Record<string, string>;
  modules: Set<string>;
  isAbstract: boolean;
  isTransient: boolean;
}

export interface OdooRuleRecord {
  xmlId: string;
  module: string;
  name?: string;
  model?: string; // resolved from model_id ref, e.g. "sale.order"
  domainForce?: string; // raw text of the domain_force field
  groups: string[]; // resolved group external ids from the groups m2m field
  isGlobal: boolean; // true when no groups are set (applies to everyone)
  location: SourceLocation;
  file: string;
}

export interface OdooCronRecord {
  xmlId: string;
  module: string;
  name?: string;
  model?: string; // resolved from model_id ref
  code?: string; // raw text of the <field name="code"> body, if present
  active: boolean;
  location: SourceLocation;
  file: string;
}

export interface OdooServerActionRecord {
  xmlId: string;
  module: string;
  name?: string;
  model?: string; // resolved from model_id ref
  state?: string; // 'code' | 'object_write' | 'object_create' | 'multi' | ...
  code?: string;
  location: SourceLocation;
  file: string;
}

/**
 * A `class X(http.Controller)` (or subclass thereof) — structurally very different from an
 * Odoo model contribution (no `_name`/`_inherit`, no fields), but its methods are exactly what
 * the security analyzer's route/auth-aware checks need to see. Kept as a separate contribution
 * type rather than shoehorned into `OdooModelContribution` so model-merging logic never has to
 * reason about "a model with no name and no fields."
 */
export interface OdooControllerContribution {
  className: string;
  methods: OdooMethodDecl[];
  module: string;
  location: SourceLocation;
}

export interface OdooManifest {
  module: string;
  dir: string; // absolute path of module directory
  depends: string[];
  data: string[];
  installable: boolean;
  auto_install: boolean;
  version?: string;
  application?: boolean;
  raw: Record<string, unknown>;
  location: SourceLocation;
}

export interface XmlNodeRef {
  tag: string;
  attributes: Record<string, string>;
  children: XmlNodeRef[];
  location: SourceLocation;
  parent?: XmlNodeRef;
  text?: string;
}

export interface OdooPythonImport {
  /** Module path as written, e.g. "odoo.exceptions" or ".models" */
  module: string;
  /** Names imported (empty for `import x`); for `from x import a, b` -> ["a","b"] */
  names: string[];
  /** True for `from .x import` / relative imports */
  isRelative: boolean;
  location: SourceLocation;
}

export interface OdooReportRecord {
  xmlId: string;
  module: string;
  name?: string;
  model?: string;
  reportType?: string; // qweb-pdf, qweb-html, ...
  reportName?: string; // t-name of the template
  file: string;
  location: SourceLocation;
}

export interface OdooTemplateRecord {
  xmlId?: string; // id= attribute when present
  tName?: string; // t-name attribute
  module: string;
  inheritId?: string;
  /** t-field / t-esc / t-out attribute values found in the template tree */
  fieldExpressions: { expr: string; kind: 't-field' | 't-esc' | 't-out' | 't-raw'; location: SourceLocation }[];
  /** t-call template names */
  tCalls: { name: string; location: SourceLocation }[];
  file: string;
  location: SourceLocation;
  archNode?: XmlNodeRef;
}

export interface OdooViewRecord {
  xmlId: string;
  module: string;
  model?: string; // the `model` field value of the ir.ui.view record
  inheritId?: string; // external id referenced by inherit_id
  viewType?: string; // form/tree/list/kanban/search/...
  archNode?: XmlNodeRef; // the <arch> root node (or the field named 'arch')
  location: SourceLocation;
  file: string;
}

export interface OdooDiagnosticFix {
  title: string;
  replacementText?: string; // if provided and safe, offered as an automatic fix
  isSafeAutoFix: boolean;
}

export interface OdooDiagnostic {
  ruleId: string;
  message: string;
  severity: 'error' | 'warning' | 'information' | 'hint';
  confidence: Confidence;
  location: SourceLocation;
  helpUri?: string;
  fixes: OdooDiagnosticFix[];
  category: 'performance' | 'security' | 'xml' | 'migration' | 'deadCode' | 'general';
}

export function normalizeInherit(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}
