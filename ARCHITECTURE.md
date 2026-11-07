# Architecture

## Design principle

There is exactly **one** semantic index. Every feature — completion, hover, definitions, the
ORM Doctor, the security analyzer, the XML validator, the dependency graph, the view visualizer,
the dead-code analyzer, impact analysis, the migration report — reads from
`OdooWorkspaceIndex` (`src/index/OdooIndex.ts`). Nothing re-implements model resolution or
inheritance merging independently. This was a hard requirement from the outset and is enforced
structurally: `src/semantic/*.ts` contains no `vscode` imports, so the domain model can't
accidentally grow VS Code-specific shortcuts, and every analyzer/command takes the index as a
constructor/function argument rather than building its own.

## Layers

```
parser/        Framework-independent parsing. No vscode imports.
  python/       tree-sitter (WASM) based Python AST access + Odoo-specific extraction
                (models AND, separately, http.Controller classes — see "Controllers" below).
  xml/          saxes-based XML parsing with source locations: view-record extraction, the
                xpath/position inheritance merger, ir.rule extraction (RuleExtractor.ts),
                ir.cron/ir.actions.server extraction (AutomationRecordExtractor.ts), and
                AttributeLocator.ts (precise attribute-value spans, for safe rename).
  manifest/     __manifest__.py literal-evaluator, ir.model.access.csv parser.

semantic/       Pure data types (OdooModel, OdooField, OdooMethod, OdooRuleRecord,
                OdooCronRecord, OdooServerActionRecord, ...). No logic, no vscode.

index/          Orchestration: module discovery + dependency ordering, model-inheritance
                merging, cross-file reference tracking (including AttributeChainResolver.ts —
                see "Reference/usage counting" below), the top-level OdooWorkspaceIndex.

analyzer/       Each analyzer is a pure function (index/analysis) -> OdooDiagnostic[].
  performance/  ORM Doctor: pluggable PerformanceRule architecture. Scans both model methods
                and controller methods (see "Controllers" below).
  security/     SecurityAnalyzer.ts (sudo()/unrestricted-search/public-mutation/csrf-disabled
                code-pattern checks, auth-aware — see "Controllers") and AclAnalyzer.ts
                (workspace-wide ACL/record-rule configuration checks: missing access rows,
                dangling model references, write-without-read, permissive global record rules).
  xml/          Field/button/xpath/duplicate-id validation.
  deadCode/     Conservative unused-field detection.
  migration/    Applies versioning/MigrationRules.ts data against source text.
  logs/         Traceback/log parsing + recurrence aggregation.
  ImpactAnalyzer.ts   Reuses the index's method-history + reference data.

versioning/     Structured, auditable migration rule *data* (see below) — deliberately kept
                out of analyzer logic.

language/       VS Code LanguageFeature providers (completion/hover/definition/rename/symbols/
                codeActions). Each is a thin adapter: resolve context -> look up in index ->
                format for VS Code.

commands/       VS Code command handlers. Each wires a QuickPick/editor selection to an
                analyzer/index query and renders a Webview or built-in UI (Peek References,
                Go to Definition, etc).

webview/        graph/GraphBuilder.ts holds PURE graph-construction logic (no vscode import,
                directly unit-testable); graph/DependencyGraphPanel.ts is the vscode-dependent
                webview wrapper around it (HTML/JS generation, CSP + nonce, panel lifecycle).
                This split exists specifically so the graph logic can be unit-tested — see the
                "Testing strategy" section for why that wasn't true before.

views/          Sidebar explorers. TreeData.ts holds PURE tree construction (model/module/
                problems trees as plain nodes, no vscode import, unit-tested); ExplorerProvider.ts
                is the single thin vscode.TreeDataProvider wrapper all three explorers share.
                Same split as webview/graph — see "Testing strategy".

runtime/        Optional live-Odoo-server integration protocol. The extension never depends on
                this being connected.

utils/          Small VS Code <-> semantic-type conversion helpers (SourceLocation -> Range,
                OdooDiagnostic -> vscode.Diagnostic, nonce generation).
```

## Controllers

Real Odoo controllers are `class X(http.Controller)`, structurally unrelated to
`models.Model` — no `_name`, no fields, no model inheritance. `OdooModelExtractor.ts` extracts
them via a separate path (`isControllerClass` / `buildControllerContribution`) into
`PythonFileAnalysis.controllerContributions`, reusing the exact same method-extraction logic
(decorators, ORM calls, attribute chains) as model methods, just without a model identity. This
exists because an earlier version of OdooLens only ever extracted `models.Model` subclasses,
which meant every `@http.route`-based security check was silently inert for real controllers —
found and fixed while testing the widened security analyzer (see CHANGELOG). Both
`SecurityAnalyzer.ts` and `OrmDoctor.ts` now scan `controllerContributions` in addition to
`modelContributions`; `ImpactAnalyzer`/dead-code/the model index correctly do NOT, since
controllers aren't models.

## Parsing strategy

- **Python**: real AST via `web-tree-sitter` + the prebuilt `tree-sitter-python.wasm` grammar
  (from the `tree-sitter-wasms` package). No regex-based Python parsing anywhere. A single
  shared literal-evaluator (`AstUtils.evalLiteral`) handles both `__manifest__.py` dicts and
  field-declaration keyword arguments (`store=True`, `default=[...]`, etc.) without using
  `eval()` — unrecognized/dynamic expressions simply evaluate to `undefined` rather than
  executing arbitrary code.
- **XML**: real streaming parser (`saxes`), not regex, with exact per-node source locations
  captured during the `opentag`/`closetag` events. This is what makes "click a node in the view
  tree, jump to that exact line" possible.

## Inheritance resolution

1. **Module dependency order**: `ModuleIndex.topologicalModuleOrder()` sorts modules so that a
   base module's contributions are always processed before a module that depends on it.
   Unresolvable external dependencies (e.g. Odoo core `sale` when only a downstream module is
   in the workspace) are treated as already-satisfied leaves, so local ordering stays correct
   even in a partial workspace.
2. **Model merging**: `ModelIndex.buildModelIndex()` walks contributions in that order. A
   contribution with `_name` (and no `_inherit`, or matching `_inherit`) establishes a model; a
   contribution with only `_inherit` extends it. Fields/methods are merged with last-writer-wins
   semantics for the "current" view, while `fieldHistory`/`methodHistory` retain every
   contribution in order — this is what powers "overridden N times across modules" in hover and
   the Impact Analyzer's override list.
3. **`_inherits` (delegation)** is recorded on the model but intentionally **not** flattened
   into the child's own field map, matching real Odoo semantics (delegated fields are proxied
   through `_inherits`, not copied).

## View inheritance (XML)

`ViewMerger.mergeViewChain()` clones a base view's `<arch>` tree, then applies each inheriting
view's patches in order:
- `<xpath expr="..." position="...">` — a **documented subset** of XPath:
  `//tag[@attr='value']` or bare `tag[@attr='value']`, matched anywhere in the tree. No axes,
  no functions, no compound predicates.
- Shorthand `<field name="x" position="after">...</field>` (no `<xpath>` wrapper), matched by
  tag+`name` attribute — this is the common case in real Odoo modules.
- `position`: `after` / `before` / `inside` / `replace` / `attributes`, applied structurally to
  the cloned tree so the visualizer shows a real merged result, not a description of one.

This is explicitly a **static approximation** of Odoo's server-side view-inheritance engine
(true resolution also depends on `priority` and full registry load order, which OdooLens
approximates via module-dependency order + discovery order). Unresolved xpath targets are
reported as `xml-xpath-target-not-found` diagnostics rather than silently dropped.

## Language feature limitations (read before trusting hover/completion)

`language/ModelContextResolver.ts` resolves "what model does this expression refer to" with
three recognized patterns, each labeled with a confidence level surfaced in the UI:

1. `self.env['model.name'].` — **high** confidence (literal string key).
2. `self.` inside a method whose enclosing class contributes to a known model — **high**
   confidence (the class's `_name`/`_inherit` is unambiguous).
3. A local variable directly assigned from `self.env['model'].search/browse/create(...)`
   earlier in the same file, or one hop through a `for x in y:` loop — **medium/low**
   confidence.

Anything else (a method return value, a variable passed as a function argument, cross-file
data flow, `with_context()`/`sudo()` chains changing behavior) is **not resolved**. OdooLens
intentionally returns no completions/hover rather than guessing, because a wrong high-confidence
suggestion is worse than no suggestion.

## Reference/usage counting

`index/ReferenceIndex.ts` powers "used by N Python files / M XML views" in hover, and gates the
dead-code analyzer. It combines several sources with different precision, documented in full in
that file's docstring:

- **Resolved attribute-CHAIN access** (`kind: 'python-attribute'`, carries a `confidence`):
  `self.partner_id.name`, `order.amount_total = ...` (assignment targets count too), and
  multi-hop patterns like `partner = self.partner_id; ... partner.name`,
  `for child in partner.child_ids: ...`, `for child in self.partner_id.child_ids: ...` (a
  multi-segment chain as the iterable itself, in one step), and `var = var.filtered(...)`,
  `var = var.filtered(...).sorted(...).exists()` (a whole SEQUENCE of type-preserving method
  calls), and `var = var.mapped('field_name')`. This is a genuine two-stage design, not a
  per-keystroke heuristic:
    1. **Extraction time** (`parser/python/OdooModelExtractor.ts`, framework-independent, one
       file at a time): captures every local-variable binding and attribute-access chain in
       *raw, unresolved* form (`RawVarBinding`, `RawAttributeChain`, `ChainRefShape` in
       `semantic/OdooTypes.ts`). It can't resolve them yet because knowing a field's comodel —
       needed to walk `.partner_id` onto `res.partner` — requires the fully-merged model index,
       which doesn't exist until every file in the workspace has been parsed. A `ChainRefShape`
       is a base + field chain plus a SEQUENCE of trailing method calls, unwound from the
       outside in then replayed left-to-right (`filtered`/`sorted`/`exists`/`sudo`/
       `with_context`/`with_user`/`with_company`/`browse`/`ensure_one`/`copy`/`search` — all
       documented by Odoo's API to preserve the recordset's model when called directly on an
       already-resolved recordset — or `mapped('single_field_name')`); it's shared between the
       `chainRef` binding case (assignment) and the `forLoopOverChain` case (for-loop iterable),
       since they resolve identically. If ANY method anywhere in the sequence is unrecognized,
       the WHOLE expression is discarded — not partially resolved up to that point — since a
       later unknown transform could change the type in a way earlier segments can't predict.
    2. **Resolution time** (`index/AttributeChainResolver.ts`, pure functions, no `vscode`
       import): once `OdooIndex` has the merged model map, `resolveVarModel()` recursively walks
       binding chains — through as many `copyVar`/`forLoopOverVar`/`chainRef`/`forLoopOverChain`
       links as present, not just one hop — and `resolveAttributeChain()` walks a raw attribute
       chain segment by segment, advancing through each relational field's comodel and
       downgrading confidence one step per field-hop (`high → medium → low`, floor at `low`).
       Type-preserving method calls do NOT add an extra downgrade, no matter how many are
       chained together (their semantics are exact, not heuristic); `mapped('field')` does
       downgrade once, since its return type genuinely depends on whether the named field is
       relational. A chain stops the moment a segment isn't resolvable — it does not guess
       further.
  What's left deliberately unresolved: attributes on a call's result where that call isn't
  itself in the whitelist above, and any expression this static approximation genuinely can't
  see through (e.g. a value round-tripped through a dict or list before being read back).
- **`@api.depends()` path strings** and **ORM-call target models** for cases the chain walk
  doesn't cover (e.g. a field only ever referenced by name inside a decorator argument).
- **XML `<field name="x"/>` tags** inside views whose `model` is known — exact by construction,
  no confidence grading needed.

A dead-code finding is suppressed by ANY usage regardless of confidence — even a low-confidence
usage means "don't flag this," consistent with the analyzer's conservative-by-design philosophy.

**A note on tree-sitter node identity**: while building the attribute-access walk, we hit and
fixed a real bug worth documenting as a general caution for anyone extending this codebase:
`web-tree-sitter` can return a *different* JS wrapper object for the same underlying syntax node
depending on how it was reached (e.g. `node.parent`'s `function` field vs. the same node reached
via a tree walk), so `nodeA === nodeB` is **not** a reliable way to check "is this the same
syntax node" — it silently fails even when both wrappers describe the identical source range.
Compare `startIndex`/`endIndex` (or use the SDK's `.equals()`) instead. `XmlNodeRef` objects
(our own plain JS objects for XML, not a native/wasm binding) don't have this problem — `===`
is correct for those, as used throughout `ViewMerger.ts`.

## Performance strategy

- **Full rebuild** (`Odoo: Rebuild Index`) walks the workspace once, parsing every file with
  tree-sitter/saxes. This is the expensive path and is wrapped in a VS Code progress
  notification.
- **Incremental updates** (`OdooWorkspaceIndex.updateFile()`) re-parse only the changed file,
  then call `incrementalRebuildModels()`, which recomputes the merged view for **only the
  models that file's old and new contributions touch** — not the whole workspace's model index.
  It does this by re-filtering the full per-model contribution list (still processed in
  module-dependency order, so override semantics stay correct) down to just the affected model
  names, then splicing the result back into `this.models`. A workspace with hundreds of
  unrelated models does not get proportionally slower to re-index after editing one file.
  `buildReferenceIndex()` now also accepts an `onlyModels` scope and is called with the same
  affected-model set on every incremental update — `ReferenceIndex.clearModel()` drops only
  that model's prior entries before repopulating, so usage counts for unrelated models are
  never discarded or recomputed. File-watcher calls into `updateFile()` are debounced (600ms)
  so rapid typing does not trigger this per keystroke.
- Manifest changes trigger a full `Odoo: Rebuild Index` (dependency graph may have changed).
- **Persistent cross-session cache** (`index/IndexCache.ts`): `OdooWorkspaceIndex.cacheFilePath`,
  when set (by `extension.ts`, to a file under `context.storageUri` — VS Code's per-workspace
  storage folder), makes `buildFull()` skip re-parsing any Python file whose mtime matches what
  was cached from the previous session. This is the difference between "re-parse everything
  every time VS Code opens this workspace" and "re-parse only what actually changed since last
  time" — on a large, mostly-unchanged codebase the second full build (and every one after)
  should see `cacheHitCount` close to `pythonFileCount`. Scoped to Python only for now:
  `XmlNodeRef` carries a `parent` back-reference (for provenance/navigation), making the tree
  circular and not directly `JSON.stringify`-able without a parent-stripping pass; XML parsing
  via `saxes` is also comparatively cheap next to tree-sitter/WASM, so this is where the caching
  effort pays off fastest. Extending the cache to XML (stripping `parent` before serializing,
  re-attaching it on load) is a natural next step if XML parsing time becomes the bottleneck on
  a large enough workspace. `odooIntelligence: Odoo: Clear Index Cache` deletes the cache file
  for when a user suspects stale data (mtime invalidation should make this unnecessary in
  practice, but it's cheap insurance). A corrupt/stale/version-mismatched cache file degrades to
  a cold cache (full reparse), never a crash — see `IndexCache.ts`'s `CACHE_VERSION`.

- **Cancellation and yielding**: `buildFull(roots, { isCancelled })` polls between files and
  yields to the event loop every 25 files via `setImmediate` (parsing is synchronous, so without
  yields the host freezes and cancel can't be observed). A cancelled build still merges models
  from what it parsed (consistent but partial, `IndexStats.cancelled`) and carries over the
  previous cache's entries for unreached files.

## Webview security

Every webview (`DependencyGraphPanel`, view-inheritance panel) sets a `Content-Security-Policy`
with `script-src 'nonce-<random>'` and no `unsafe-inline` script execution, uses
`webview.cspSource` for styles, and communicates exclusively via `postMessage` — the webview JS
never has direct filesystem access; "open source" clicks are relayed back to the extension host,
which validates the path came from index data before opening it.

## Runtime protocol

`OdooRuntimeProvider` (`src/runtime/protocol/OdooRuntimeProvider.ts`) is a small, transport-
agnostic interface; `JsonRpcRuntimeProvider` is the shipped implementation. It speaks to the
companion Odoo module in `odoo-helper/` — four read-only POST endpoints (`/odoolens/models`,
`/model`, `/field`, `/views`) gated by a bearer token stored as the `odoolens.api_token` system
parameter (unset = everything refused). The helper keeps all logic in a pure `introspection.py`
(no `odoo` import; tested with plain-Python fakes, `npm run test:helper`) and a thin
`controllers/main.py` that supplies a real environment. The client is tested over a real socket
against a fake endpoint implementing the same contract (`tests/runtime/`). Credentials live only
in VS Code `SecretStorage`. The core extension never depends on this being connected —
`Odoo: Inspect Runtime Registry` labels STATIC INDEX vs RUNTIME REGISTRY and works fine showing
"not connected". Known unverified step: the controller shell has not run against a real Odoo.

## Testing strategy

`tests/fixtures/basic_odoo/` is a realistic 3-module chain (`base_module` → `sale_extension` →
`custom_sale`) exercising classic inheritance, computed fields with `@api.depends`, view
inheritance via both `<xpath>` and shorthand position, a deliberately-unused field, a `sudo()`
call, a nested-loop ORM call, a repeated `self.env[...]` access pattern, and both a
missing-field and a missing-xpath-target XML bug.

Two independent test layers exist:

1. **Unit tests** (`tests/**/*.test.ts`, run via `npm test`) exercise the parser/index/analyzer
   layer directly — no VS Code host needed, since that layer never imports `vscode`. 86 tests
   as of this writing, covering manifest parsing, model-inheritance merging, incremental
   (scoped) re-indexing, ORM Doctor rules (including inside controller methods), the security
   analyzer (including auth-aware controller checks), the ACL/record-rule analyzer, XML
   validation, dead-code detection, the view-inheritance merger, the attribute-chain resolver,
   the dependency-graph builder, and the log/migration engines.

   **A note on why `webview/graph/GraphBuilder.ts` is a separate file**: it used to live inside
   `DependencyGraphPanel.ts`, which has a top-level `import * as vscode from 'vscode'`.
   TypeScript compiles that to a top-level `require("vscode")`, executed at module-load time
   for ANY import from that file — including a pure function that never touches `vscode` at
   runtime. Outside a real Extension Host, that `require` throws `Cannot find module 'vscode'`
   immediately, so the graph-building logic was completely untestable by this unit suite. This
   was only discovered when adding tests for the new unified-model-graph feature, and the fix
   (split into a `vscode`-free `GraphBuilder.ts` + a thin `DependencyGraphPanel.ts` wrapper) is
   the template to follow if similar pure logic ever ends up stranded in a `vscode`-importing
   file again — check `webview/**` and `commands/**` first if a "should be testable" function
   isn't showing up in coverage.

2. **Integration tests** (`src/test/suite/*.integration.test.ts`, run via
   `npm run test:integration`) launch a **real** VS Code Extension Development Host via
   `@vscode/test-electron`, open the fixture workspace, and exercise the `vscode`-dependent
   layers directly: extension activation, every command declared in `package.json` actually
   being registered, hover returning real field intelligence via
   `vscode.executeHoverProvider`, and completion after `self.env['sale.order'].` returning known
   field names via `vscode.executeCompletionItemProvider`.

   **Known environment limitation**: `@vscode/test-electron` downloads a real VS Code binary
   from `update.code.visualstudio.com` on first run. This project was built and unit-tested
   inside a sandboxed dev environment whose network egress allowlist is scoped to package
   registries only (npm/pip/crates/etc.) and does not include that download host — running
   `npm run test:integration` there fails with `Failed to parse response from
   https://update.code.visualstudio.com/... as JSON`, i.e. a blocked/empty response, not a test
   or extension defect. The integration suite is written and compiles cleanly
   (`tsc -p ./` includes `src/test/**`), and will run normally in any environment with ordinary
   internet access (a developer machine, or CI runners like GitHub Actions' standard ubuntu
   images) — see `.github` CI setup as a next step if you want this enforced automatically.
