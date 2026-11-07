# Changelog

## 0.1.1 - Extension Repo Change

Fixed the nam eof the repo of OdooLens.

## 0.1.0 — Initial foundation

First working build of OdooLens. Establishes the core semantic index and the highest-value
analyzers/language-features on top of it.

### Added (this update, part 13) — worker-thread parse pool + more ORM Doctor rules

- **Optional worker-thread Python parse+extract** (`ParseWorkerPool` / `parseWorkerEntry`): workers return JSON analyses only; on any failure the pool disables itself and falls back to the existing main-thread path — no behaviour change when workers are unavailable.
- **ORM Doctor rules (additive)**: `repeated-equivalent-search`, `python-filter-after-search`, `singleton-id-search-in-loop`, `unnecessary-browse`, `record-by-record-write`, `sudo-in-loop`.
- `filtered` / `sorted` / `filtered_domain` now recorded on `ormCalls` so filter-related rules can fire.

### Added (this update, part 12) — imports/modules/reports dead-code + QWeb analysis

- **Python import extraction** on every file (`OdooPythonImport`) for unused-import dead-code.
- **Report + QWeb template index**: `ReportExtractor`, `TemplateExtractor`; stored on `XmlFileAnalysis` and workspace index.
- **Dead-code**: unused imports, unused modules (no dependents, not an app), unused/incomplete reports.
- **QWeb analyzer**: unresolved `t-call` / template inherit, `t-field` vs report model fields.
- Fixture report/template under `custom_sale/reports/`; regression tests in `XmlAndDeadCode.test.ts`.
- Cache **v6**.

### Added (this update, part 11) — gap closure toward the original product plan

- **Find All References** (`OdooReferenceProvider`) for fields, methods, and model-name strings.
- **Method rename** now rewrites `self.method()` call sites via new `calledMethodSites` locations.
- **Dead-code** expanded: unused models, orphan views, unreferenced XML IDs, empty crons/server actions (still conservative confidence).
- **ORM Doctor** new rules: `mapped-in-loop`, `read-in-loop`, `nested-orm-in-loop`.
- **XML version-aware checks**: deprecated `attrs=`/`states=` (17+), `<tree>` root (18+), driven by detected workspace major version.
- **View inheritance visualizer** lists the full modification chain above the effective tree.
- Cache version **v5** (`calledMethodSites`).

### Added (this update, part 10) — rename completeness, dead-code methods, XML cache, concurrent parse

- **Field rename now covers high-confidence Python attribute accesses and exact single-segment
  `@api.depends` / `related=` paths.** The extractor records identifier locations for attribute
  segments and string-content locations for decorator args / `related=` kwargs. Multi-segment
  paths and low-confidence heuristics are still left for the user.
- **Model rename covers XML `model=` / `<field name="model">` and conventional
  `ir.model.access.csv` `model_id:id` cells**, in addition to `_name`/`_inherit` and
  `self.env[...]`.
- **Dead-code analyzer flags private methods** (`_foo`, not dunder, not ORM hooks) with zero
  static callers, only on models fully defined in the workspace.
- **Index cache extended to XML** (v4): parent pointers stripped on serialize / restored on
  load. Cache version bumped; old caches discarded safely.
- **Parsing uses a concurrency pool** (`PARSE_CONCURRENCY = 4`) so I/O and extraction overlap
  across files while still yielding for cancellation. True worker-thread offload of tree-sitter
  WASM remains blocked by host constraints; this is the practical equivalent.
- **XML validator** reports unresolved `model=` references (`xml-unresolved-model`).

### Added (this update, part 9) — migration rules for views

- **Fixed another rule that could never fire**: `Odoo: Generate Migration Report` only scanned
  Python files, so the one `xml`-category rule (`attrs-states-deprecated-views`) had never been
  applied to any XML file. The report now scans XML too, and `runMigrationAnalyzer` takes a file
  `kind` so each rule only runs against the file type it was written for (an XML rule's regex
  has no business matching Python source, or vice versa). Regression-tested.
- **Three new 17→18 rules, verified from sources rather than memory** (Odoo community answers
  quoting the real Odoo 18 errors, the official 18.0 tutorial, and an independent write-up):
  `<tree>` → `<list>` as the list view's root tag (a `<tree>` arch fails to load with
  `Wrong value for ir.ui.view.type: 'tree'`), and `view_mode` still listing `tree` in both XML
  actions and Python action dicts (`View types not defined tree found in act_window`). All
  `error`/`high`. Sources disagree on whether Odoo 19 still tolerates `<tree>`; the rules are
  scoped to the 17→18 transition, where the failure is documented.
- 7 new tests (155 total).

### Added (this update, part 8) — analyzer breadth: XML ids and authorization checks

- **Fixed a detector that had never fired**: `findDuplicateXmlIds` iterated `viewsById`, a `Map`
  keyed by the very id being checked, so it could never contain a duplicate (the existing
  "no duplicates in the clean fixture" test passed trivially). Found by reading the code with
  suspicion, proven with a failing test first, then rewritten to scan every file's declared ids —
  and thereby extended from views-only to every id-declaring element (records, menuitems,
  templates, act_windows, reports).
- **New `xml-unresolved-ref` rule**: flags `ref=`, `eval="ref('...')"`, menuitem
  `action`/`parent`/`groups`, and `<button type="action">` references into a *workspace* module
  whose id no XML file or access-CSV row declares. Guarded against false positives: refs into
  modules outside the workspace are skipped (can't be judged), ORM-generated ids (`model_*`,
  `field_*`, `constraint_*`, `index_*`) are exempt, access-CSV rows count as declarations, bare
  numeric button ids are ignored, and `inherit_id` is excluded (it has its own rule — no
  double-reporting). Probed against the realistic fixture workspace: 0 false positives.
- **New `sudo-mutation-without-auth-check` security rule**: a public, RPC-reachable model method
  that calls `sudo()`, then `write`/`create`/`unlink`, with no access check anywhere in its body
  (`check_access*`, `has_access`, `has_group`, `user_has_groups`, ...). Low-confidence review
  prompt, not a vulnerability claim. Exempts private methods, `@api.private`, and
  framework-invoked decorators (`@api.depends`/`constrains`/`onchange`/`autovacuum`). Needed a
  new `OdooMethodDecl.calleeNames` (the final name of every call in a body); the persistent
  cache version is bumped to 2 for the shape change, so old caches are discarded safely.
- 22 new tests (3 + 10 XML-id, 9 authorization-check); 148 total.

### Added (this update, part 7) — cancellation and responsiveness

- **`Odoo: Rebuild Index` is now cancellable and no longer blocks the extension host.**
  `buildFull(roots, { isCancelled })` polls cancellation between files and yields to the event
  loop every 25 files (tree-sitter parsing is synchronous, so previously a large rebuild froze
  the host and a cancel request could never even be observed). Cancelling leaves an internally
  consistent but partial index (models are merged from whatever was parsed; `IndexStats.cancelled`
  is set and the user is told), and cache entries from the previous session are carried over so
  a cancelled cold build doesn't throw away prior work. 5 new tests, including a mutation-checked
  one proving a timer can fire mid-build (it fails if yielding is disabled).
- Still open from this area: moving parsing to worker threads. Yielding fixes responsiveness,
  but a cold build still uses the main thread's CPU, just in slices.

### Added (this update, part 6) — runtime helper module

- **`odoo-helper/odoolens_helper`: the Odoo-side half of the runtime registry feature**, which
  previously had a client with nothing to connect to. Four read-only endpoints
  (`/odoolens/models|model|field|views`), bearer-token gated via the `odoolens.api_token` system
  parameter (unset = all requests refused; constant-time comparison; no exception details in
  responses). Logic is in a pure `introspection.py`; the controller is a thin shell.
- **Tests for both halves**: 12 Python unit tests for the introspection logic (plain fakes, `npm
  run test:helper`, added to CI) and 6 TypeScript tests running the real
  `JsonRpcRuntimeProvider` over a real socket against a fake endpoint implementing the same
  contract — the client had never been executed before this. 121 TS tests now.
- Writing the Python tests caught a test-fidelity trap: my first fake returned a plain `list`
  where real Odoo returns a singleton recordset, and the code's deliberately broad
  best-effort `except` silently swallowed the resulting error, so the assertion failed for the
  wrong-looking reason. Fixed the fake to model a recordset faithfully.
- **Not verified**: the controller shell has never run against a real Odoo server (no Odoo in the
  build environment). Documented in `odoo-helper/README.md`, README, and ARCHITECTURE.

### Added (this update, part 5) — sidebar tree views

- **Three sidebar explorers** (activity-bar "OdooLens" container): Models (fields/methods per
  model), Modules (dependency-ordered, with contributed models and dependencies), and Problems
  (findings grouped by category, security first). Pure tree construction lives in
  `views/TreeData.ts` (no `vscode` import, 11 unit tests); `views/ExplorerProvider.ts` is the one
  thin wrapper shared by all three. Click-to-open via a hidden `odooIntelligence.openLocation`
  command.
- `DiagnosticsManager` now retains raw `OdooDiagnostic`s (category/confidence as data, not baked
  into message text) and emits `onDidChangeDiagnostics`; a full rebuild fires it once, not once
  per file.
- Packaging fix: compiled test output (`out/tests/**`) was being shipped inside the `.vsix`;
  excluded (102 → 85 files, 370KB → 337KB).
- Closes the "no sidebar tree views" gap. Not verified inside a real Extension Host (see the
  integration-suite caveat in ARCHITECTURE.md) — the pure logic is unit-tested, the VS Code
  wiring compiles and packages but has not been clicked through.

### Added (this update, part 4) — unused settings, persistent cache

- **Every declared setting now does something (or is honestly labeled as not yet doing
  anything)**: a review found 6 settings declared in `package.json` that no code ever read.
  - `odooIntelligence.addonsPaths` now actually extends the scan beyond the open workspace
    folders (resolved relative to the first workspace folder, or absolute).
  - `odooIntelligence.odooVersion` now drives real auto-detection: a new, unit-tested
    `detectMajorVersion()` (in `versioning/MigrationRules.ts`, framework-independent) picks the
    most common leading major version across indexed manifests' `version` fields, used as the
    default "from" version in `Odoo: Generate Migration Report` — this is what `"auto"`
    concretely does now, not a placeholder string.
  - `odooIntelligence.enableMigrationAnalyzer` / `enableRuntimeRegistry` now actually gate their
    respective commands (they tell the user they're disabled, rather than the setting existing
    purely as decoration).
  - `odooIntelligence.logLevel` is implemented via a new `utils/Logger.ts` (rank-based
    error/warning/information/hint gating) wrapping the "OdooLens" output channel; every
    `output.appendLine` call site now goes through it.
  - `odooIntelligence.pythonPath` remains unused — but its description already says "(reserved
    for future runtime helper use)", so this was already an honest placeholder, not a broken
    promise, and needed no change.
- **New persistent, cross-session index cache** (`index/IndexCache.ts` + wiring in
  `OdooWorkspaceIndex.buildFull()`), closing the "no persistent index cache" gap: Python
  analyses (the dominant parsing cost — tree-sitter/WASM) are cached to a file under
  `context.storageUri`, keyed by file mtime, so reopening a large, mostly-unchanged workspace
  doesn't re-parse everything from scratch. Scoped to Python only for now — `XmlNodeRef`'s
  circular `parent` back-reference isn't directly JSON-serializable without extra work, and XML
  parsing is comparatively cheap anyway (see `ARCHITECTURE.md § Performance strategy` for the
  full reasoning and the documented follow-up). A corrupt/stale/version-mismatched cache
  degrades to a cold cache, never a crash. New `Odoo: Clear Index Cache` command as a manual
  escape hatch. `IndexStats.cacheHitCount` surfaces hit/miss counts in the "OdooLens" log.
  7 new tests (3 pure serialization tests + 3 real-filesystem integration tests proving actual
  cache hits/misses/invalidation, using `fs.utimesSync` to verify mtime-based invalidation
  specifically, not just "it ran without crashing").

### Added (this update, part 3) — gap closure pass

- **ESLint** (`eslint.config.js`, flat config, `npm run lint`): previously `CONTRIBUTING.md` and
  `.vscodeignore` referenced lint tooling that didn't exist. First run surfaced 10 genuine minor
  issues (unused imports/params/variables, a floating promise in the integration test runner, a
  stale `eslint-disable` directive, an unused test helper) — all fixed, lint now reports zero
  warnings. One fix was a real (small) improvement rather than just silencing a warning:
  completion items for methods now show their decorators in the detail text (the previously
  unused `method` variable).
- **Rename now covers methods and models, not just fields**:
  - *Method* rename: every declaration/override site (new `OdooMethodDecl.nameLocation`, exact
    AST identifier location) plus XML `<button name="..." type="object">` references. Does not
    rename `self.method()` call sites — OdooLens tracks that such calls exist, but not their
    exact source location.
  - *Model* rename: every `_name`/`_inherit` string-literal contents (new
    `OdooModelContribution.nameLocation`/`inheritLocations`) and every `self.env['...']` string
    (new `EnvAccessSite.keyLocation`). Deliberately does NOT touch XML `<field name="model">`,
    `ir.model.access.csv` rows or the `model_<name>` external-id convention — model rename has a
    much larger blast radius than a field/method (a mismatched external id can break module
    installation), so the user is told to search for the old name and finish by hand.
  - Fixed a correctness bug caught while writing this: the rename line-cache was initially
    module-level, which would have served stale file contents across separate rename operations
    in one session if the user edited a file in between. Now scoped per-call.
  - 2 new integration tests (method rename touching 2 Python files + XML; model rename touching
    multiple modules) — written and compile clean, but not executed in the build sandbox (see
    the integration-suite caveat in `ARCHITECTURE.md`).
- **RPC reachability in Impact Analysis**: `analyzeImpact()` now reports whether a method is
  reachable via Odoo's XML-RPC/JSON-RPC `execute_kw()` API — a public name (no leading
  underscore) with no `@api.private` (Odoo 18.2+) on any declaration. This is deliberately the
  concrete, checkable static fact in place of the impossible "find external RPC callers" (an
  external system could call any reachable method at any time; no amount of source analysis can
  enumerate that). 3 new tests.
- **Environment note**: partway through this pass the build sandbox's filesystem was reset,
  losing all uncommitted work (ESLint config, lint cleanups, and the model/method location
  tracking). Everything was restored from the last delivered zip and redone — nothing was lost
  from the shipped project, but it's worth knowing that the "checkpoint via `present_files`"
  habit of repackaging after each meaningful milestone exists for a real reason.

### Added (this update, part 2)

- **Impact Analyzer now checks scheduled/server actions**: `analyzeImpact()` searches `ir.cron`
  and `ir.actions.server` `code` fields for calls to the method in question, closing the
  specific gap its own `confidenceNote` used to name. Necessarily a text search (Odoo `exec()`s
  these as free-form Python, so there's no AST to resolve against), word-boundary-matched to
  avoid substring false positives (`confirm` no longer matches `action_confirm`). This reused
  data the ACL/graph work already parses (`OdooWorkspaceIndex.cronRecords`/`serverActionRecords`)
  that had gone unused for impact analysis specifically. 5 new tests. RPC callers remain
  unresolved — the `confidenceNote` is updated to say so precisely, not just "not yet resolved"
  as a single vague bucket.

### Added (this update) — widened security analyzer + dependency graph

- **New ACL/record-rule analyzer** (`src/analyzer/security/AclAnalyzer.ts`), reading
  `ir.model.access.csv` and `<record model="ir.rule">` against the merged model index:
  `no-access-rule-defined` (a model this workspace defines has zero access rows anywhere),
  `dangling-access-rule-model` (a CSV row's `model_id` doesn't match any indexed model),
  `acl-write-without-read` (a row grants write/create/unlink without read — a common
  misconfiguration smell), and `permissive-record-rule` (a global `ir.rule` with an
  empty/always-true domain). New parsers: `RuleExtractor.ts`, `AutomationRecordExtractor.ts`
  (`ir.cron`, `ir.actions.server`), wired into `OdooWorkspaceIndex` for both full and
  incremental scans.
- **RPC-exposure-aware security checks**: `@http.route(...)`'s keyword arguments (`auth`,
  `csrf`) are now actually parsed (`OdooDecorator.kwargs`, new) and used to grade every
  existing security finding — a mutation behind `auth='public'` now escalates to `high`
  confidence instead of being treated the same as one behind the (default) `auth='user'`; a new
  `csrf-disabled-route` rule flags `csrf=False`.
- **Fixed a real, previously-silent bug found while testing the above**: controller classes
  (`class X(http.Controller)`) were never extracted at all — every route-decorator security
  check had been effectively inert for real Odoo controllers this whole time, since Odoo
  controllers aren't `models.Model` subclasses. Added a proper `OdooControllerContribution`
  extraction path (`PythonFileAnalysis.controllerContributions`), wired into both the security
  analyzer and the ORM Doctor (an N+1 loop pattern inside a controller method is just as real a
  bug as one inside a model method). Also fixed a related casing bug (`csrf=False`'s stringified
  form is lowercase `'false'`, not `'False'`) caught by the same test.
- **Fixed a latent bug**: `OdooModel.isAbstract`/`isTransient` were declared but never actually
  set anywhere (`AbstractModel`/`TransientModel` base classes weren't tracked). Added
  `OdooModelContribution.baseClass` detection and wired it through `ModelIndex.ts`.
- **Fixed a real diagnostics-duplication bug** found while wiring the ACL analyzer in:
  workspace-wide diagnostics (dead code, duplicate XML ids) were being appended, never cleared,
  on every incremental re-index — split `DiagnosticsManager` into two collections (per-file vs.
  workspace-wide) so the workspace-wide one is correctly cleared-and-replaced each time.
- **New "Unified model graph" option** for `Odoo: Show Dependency Graph` — one graph spanning
  fields (ALL of them, not just relational ones), methods, views, scheduled actions (`ir.cron`),
  server actions (`ir.actions.server`), and security (access rows + record rules), grouped under
  category nodes so it stays legible even for models with many fields. This directly closes the
  "unified fields+methods+views+cron+security tree" gap.
- **Architectural fix**: split the dependency-graph module into a pure `GraphBuilder.ts` (no
  `vscode` import) and a `vscode`-dependent `DependencyGraphPanel.ts`. This wasn't cosmetic —
  the graph-building functions were previously completely untestable by the unit suite (`import
  vscode` at the top of a file makes anything imported from it fail outside a real Extension
  Host), which was only discovered while trying to add tests for the new unified graph.
- **Packaging fixes, found while verifying `vsce package` actually works** (previously never
  tested): added a missing `LICENSE` file (declared as MIT in `package.json` but absent), and
  excluded ~35 unused `tree-sitter-wasms` language grammars via `.vscodeignore` — OdooLens only
  parses Python, so bundling all of them wasted ~4.3MB (93% of the packaged `.vsix`) for nothing.
- 19 new tests across the ACL analyzer, widened security analyzer, controller extraction, and
  the newly-testable graph builder.

### Added (previous update)

- **Closed the final two documented gaps** in attribute-access resolution: chaining multiple
  type-preserving method calls together (`var.filtered(...).sorted(...).exists()`, arbitrary
  length, not just one), and widened the type-preserving method whitelist with two more
  genuinely same-model-returning Odoo API methods (`copy()`, and `search()` called directly on
  an already-resolved recordset rather than on `self.env[...]`). Generalized `ChainRefShape.
  trailingMethod` (singular) into `trailingMethods` (an ordered array), resolved by looping
  through each entry in sequence — if ANY method in the sequence is unrecognized, the whole
  chain is discarded rather than partially resolved, since a later unknown transform could
  change the type in a way earlier segments can't predict. 5 new tests (4 pure-resolver + 1
  fixture-level, the fixture one exercising `.filtered(...).sorted()` chained together in a real
  compute-style method).

### Added (previous update)

- **Closed the last two documented gaps** in attribute-access resolution:
  - For-loop iterables that are themselves multi-segment chains (`for child in
    self.partner_id.child_ids:`) now resolve in one step, not just single-attribute iterables.
  - Variable reassignment via a known type-preserving method call (`active = partner.filtered(...)`,
    `children = partner.mapped('child_ids')`) now resolves correctly, instead of losing the
    variable's type.
  Generalized the binding model to a shared `ChainRefShape` (base + field chain + an optional
  single trailing method call) used identically by both the `chainRef` (assignment) and
  `forLoopOverChain` (for-loop) cases — they're the same shape resolved the same way, just
  captured from different syntax. The trailing-method whitelist (`filtered`, `sorted`, `exists`,
  `sudo`, `with_context`, `with_user`, `with_company`, `browse`, `ensure_one`) covers Odoo API
  methods documented to preserve the recordset's model exactly, so no confidence downgrade is
  applied for those; `mapped('field')` does downgrade once, since its return type genuinely
  depends on whether the field is relational. 9 new tests (7 pure-resolver + 2 fixture-level).

### Added (previous update)

- **Multi-hop chained-access resolution and true variable indirection**, closing the two gaps
  explicitly called out in the previous release's limitations. Restructured attribute-access
  tracking into two stages: extraction time now captures raw, unresolved binding/chain shapes
  (`RawVarBinding`, `RawAttributeChain`), and a new `index/AttributeChainResolver.ts` walks them
  once the fully-merged model index is available — advancing through each relational field's
  comodel and downgrading confidence one step per hop. This means:
  - `self.partner_id.name` now correctly attributes `name` to `res.partner`, not `sale.order`
    (previously the chain stopped after `partner_id`).
  - `partner = self.partner_id; ...; partner.name` now resolves `partner`'s type (previously
    only `self`, `self.env[...]`, and simple `for x in y:` loops were understood).
  - `for child in partner.child_ids:` now resolves `child` through the relational field on an
    already-resolved variable, not just through `self`.
  9 new tests: 7 pure-function tests against the resolver directly (`AttributeChainResolver`)
  and 2 end-to-end tests against the fixture workspace.

### Added (previous update)

- **Real Python attribute-access tracking**, replacing the old "only `@api.depends()` paths and
  ORM-call targets" approximation. Every `self.<field>` / `record.<field>` access — including
  assignment targets like `order.amount_total = ...` inside compute methods, previously
  untracked entirely — is now resolved to a specific model via the same first-hop heuristics as
  the interactive completion/hover resolver, and recorded with an explicit confidence level.
  This makes hover "used by" counts and dead-code detection meaningfully more accurate without
  requiring full type inference. See `parser/python/OdooModelExtractor.ts §
  collectAttributeAccesses` and `ARCHITECTURE.md § Reference/usage counting`.
- **Fixed a real web-tree-sitter node-identity bug** found while building the above: comparing
  `SyntaxNode` objects with `===` is unreliable (the SDK can return a fresh wrapper for the same
  underlying node depending on the access path), which had caused every `self.method()` call to
  be briefly, incorrectly counted as a field usage of `method` during development of this
  feature. Fixed by comparing `startIndex`/`endIndex` instead; documented as a general caution
  in `ARCHITECTURE.md` for anyone extending the AST-walking code. Caught by a new regression
  test (`does not count a direct method call ... as a field usage`) — good example of the test
  suite doing its job.
- Removed 3 leftover empty scaffold directories (`src/runtime/client`, `src/versioning/rules`,
  `src/webview/viewTree`) from the initial project layout that were never populated because the
  actual implementation was organized differently — no functional impact, just cleanup.
- 5 new regression tests for the attribute-access tracking (chained access, method-call
  exclusion, framework-attribute exclusion).

### Added (previous update)

- **Filled the 15→16 migration-rule gap** with 5 more verified rules sourced from Odoo's
  official ORM changelog: `args=` renamed to `domain=` on `search()`/`search_count()`/
  `_search()`, `fields_get_keys()`/`get_xml_id()` deprecated, `_mapped_cache()` removed,
  `Model._sequence` removed, and `Field.column_format`/`Field.deprecated` removed. Every
  migration-rule transition from 14→19 now has at least one populated rule. 5 new regression
  tests.

### Added (previous update)

- **Broadened the migration rule set to verified Odoo 18→19 changes**, sourced by consulting
  Odoo's official ORM changelog page rather than guessing: `read_group()` deprecated in favor
  of `_read_group()`/`formatted_read_group()`, the legacy `odoo.osv` import path deprecated, and
  `self._cr`/`self._uid`/`self._context` deprecated in favor of `self.env.cr`/`self.env.uid`/
  `self.env.context`. Also added a verified 17→18 rule: `check_access_rights()`/
  `check_access_rule()` superseded by the unified `check_access()`/`has_access()`/
  `_filtered_access()` API. Every new rule's `documentationUrl` points at the specific official
  changelog page the deprecation is documented on. 5 new regression tests.

### Added (previous update)

- **Hardened rename to safely cover XML `<field name="...">` usages**, not just declarations.
  New `AttributeLocator.locateAttributeValue()` pinpoints an XML attribute's exact value span
  (something the streaming `saxes` parser doesn't give us for free — it only reports whole-tag
  positions) by scanning just that element's own line range, so a rename edit can target the
  precise substring instead of guessing. Renaming a field now updates every declaration site
  *and* every `<field name="oldName">` reference on a view whose `model` matches, while Python
  usages (attribute access, domain tuples) remain intentionally out of scope — see
  `src/language/rename.ts` for the full, updated rationale. Covered by both a new unit test
  (`tests/xml/XmlParserAndMerger.test.ts` → `AttributeLocator`) and a new VS Code integration
  test exercising the real rename provider end-to-end.

### Added (previous update)

- **Rename support**: renames a field's declaration site(s) across every module that
  (re-)declares it, using exact tree-sitter-derived identifier locations — not a text
  search-and-replace, so it can't clip an unrelated same-named local variable. Deliberately
  does NOT rename usages (Python domains, XML `<field name="...">` references), since the
  reference index is a best-effort approximation; the user is warned and pointed at "Odoo: Find
  Field Usages" to finish the job manually. See `src/language/rename.ts` for the full rationale.
- **Two new ORM Doctor signals**: nested-loop severity escalation (an ORM call 2+ loops deep
  now reports `high` confidence instead of `medium`, with an explicit "(nested N loops deep)"
  message) and a new `repeated-env-access` rule flagging 3+ separate `self.env['same.model']`
  lookups within one method.
- **Real VS Code integration test suite** (`src/test/suite/*.integration.test.ts`) using
  `@vscode/test-electron`, covering extension activation, full command registration, hover, and
  completion against the fixture workspace in an actual Extension Development Host — see
  `ARCHITECTURE.md § Testing strategy` for the one documented environment caveat (VS Code
  binary download requires normal internet access; this was written and compiled, but not
  executed, inside a network-restricted sandbox).

### Added (previous update)

- **Scoped reference-index updates**: `buildReferenceIndex()` now accepts an `onlyModels`
  filter and `ReferenceIndex.clearModel()` drops just one model's entries, so incremental file
  updates no longer discard/recompute usage counts for every unrelated model in the workspace.

### Added (previous update)

- **True incremental model-index updates**: editing one file now only recomputes the specific
  models that file's contributions touch, instead of re-merging every model in the workspace.
  See `OdooWorkspaceIndex.incrementalRebuildModels()` and `ARCHITECTURE.md`.

### Added

- **Parsing**: real Python AST parsing (`web-tree-sitter` + `tree-sitter-python.wasm`); real
  streaming XML parsing with source locations (`saxes`); safe literal-evaluator for
  `__manifest__.py` and field keyword arguments; `ir.model.access.csv` parser.
- **Semantic index**: module discovery + dependency-ordered topological sort; model inheritance
  merging (`_name`/`_inherit`/`_inherits`) with full field/method override history; cross-file
  reference index for usage counts.
- **View inheritance engine**: `<xpath>` + shorthand-position merger producing an effective view
  tree, with provenance tracking and unresolved-target diagnostics.
- **ORM Query Doctor**: pluggable rule architecture; ships `search/browse/create/write/unlink`
  in-loop detection and `search_count([])` misuse detection.
- **Security analyzer**: `sudo()` bypass, unrestricted-search-from-controller, and
  public-controller-mutation checks, each with an explicit confidence level.
- **XML validator**: field-existence, button-method-existence, xpath-target-existence, and
  duplicate-external-id checks.
- **Dead code analyzer**: conservative unused-field detection (never claims
  "definitely unused").
- **Migration assistant**: structured, data-driven rule set (`versioning/MigrationRules.ts`)
  covering a first verified batch of 14→15, 16→17, and 17→18 changes; report webview.
- **Impact analyzer**: method override history + Python call sites + XML button references,
  reusing the shared index.
- **Log/traceback navigator**: parses Odoo tracebacks and bare exception lines, with recurring-
  error aggregation.
- **Language features**: completion/hover/definition for `self.env['model']`, `self.` inside a
  known model's method, and a one-hop local-variable heuristic — each result labeled with its
  resolution confidence. Workspace symbol provider (Ctrl+T) for models/fields/methods. A
  CodeActionProvider surfaces non-destructive "show suggested fix" snippets for ORM Doctor
  loop findings and "learn more" links for any diagnostic with a help URI.
- **Dependency graph webview**: interactive pan/zoom/click SVG graph for both module
  dependencies and per-model relationships; CSP + nonce, no unsafe-inline.
- **View inheritance visualizer webview**: effective-tree rendering with per-node "introduced by
  module X" provenance and click-to-open-source.
- **Runtime registry protocol**: transport-agnostic `OdooRuntimeProvider` interface + a JSON
  reference implementation; `Odoo: Connect to Runtime` stores credentials in VS Code
  `SecretStorage` only.
- **Test suite**: fixture-based tests (`tests/fixtures/basic_odoo/`, a realistic 3-module
  inheritance chain) covering the parser, index, and analyzer layers.

### Known limitations

See `README.md § Known limitations` and `ARCHITECTURE.md § Language feature limitations` /
`§ Reference/usage counting`. Highlights: no full type inference for language features;
incremental file updates still recompute the whole merged model index; XPath support is a
documented subset; impact analysis does not resolve `ir.cron`/server-action/RPC callers.
*(All four of those were true as of the initial 0.1.0 build; several have since been closed —
incremental updates are now scoped, and impact analysis now covers cron/server actions and RPC
reachability. See the "Added (this update…)" entries above for what changed and when.)*

### Not yet implemented (tracked as next steps)

- **Verification that requires a real environment, not more code**: the `@vscode/test-electron`
  integration suite (`npm run test:integration`) has never actually passed anywhere — only
  confirmed to fail with the expected network error inside this project's sandboxed build
  environment (no access to update.code.visualstudio.com). It is written and compiles clean;
  it needs to be run once on a machine/CI runner with ordinary internet access. The GitHub
  Actions workflow (`.github/workflows/ci.yml`) is likewise written but has never run on a real
  runner. Similarly, no performance testing has been done against a genuinely large Odoo
  codebase (only the 3-module fixture).
- Safe automatic CodeActions that actually rewrite ORM Doctor loop code (currently a
  non-destructive "show suggested fix" comment insertion, by design — see the "Quick Fixes"
  philosophy in the original spec).
- Rename support for Python usages of a field/method (attribute access, `self.method()` call
  sites, domain tuples) — would require upgrading the Python reference tracking to carry exact
  source locations for every usage (today it carries confidence-graded locations that are
  precise enough for hover/dead-code, but not for an automated text edit), plus real
  type-inference-backed precision, before it's safe to auto-rewrite.
- Renaming the *rest* of a model rename's blast radius (XML `<field name="model">` view
  declarations, `ir.model.access.csv` rows and their `model_<name>` external-id convention).
- **Worker-thread offloading** of parsing (cancellation and yielding are done; see part 7) —
  a cold build still consumes main-thread CPU, in slices.
- Running the `odoo-helper` controller against a real Odoo server (the one unverified step of
  the runtime feature).
- Extending the dead-code analyzer beyond fields (models, methods, views, XML ids, cron jobs,
  imports, reports — the spec's original list), and the XML validator's remaining items (invalid
  `model=` references, version-aware attribute checks). Missing external-id, button-action and
  missing-authorization-check detection are done (part 8).
