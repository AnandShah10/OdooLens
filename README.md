# OdooLens

**Odoo-aware developer intelligence for Visual Studio Code**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-007ACC?logo=visual-studio-code&logoColor=white)](https://code.visualstudio.com/)
[![Odoo](https://img.shields.io/badge/Odoo-14%E2%80%9319-714B67?logo=odoo&logoColor=white)](https://www.odoo.com/)
[![CI](https://img.shields.io/github/actions/workflow/status/AnandShha10/OdooLens/ci.yml?branch=main&label=CI)](https://github.com/AnandShha10/OdooLens/actions)
[![GitHub stars](https://img.shields.io/github/stars/AnandShha10/OdooLens?style=social)](https://github.com/AnandShha10/OdooLens)
[![GitHub issues](https://img.shields.io/github/issues/AnandShha10/OdooLens)](https://github.com/AnandShha10/OdooLens/issues)

> VS Code finally understands Odoo.

**OdooLens** (Odoo Intelligence) gives the editor real, structural understanding of an Odoo codebase: the ORM model registry, field and method inheritance, XML view inheritance, manifests, dependencies, security patterns, QWeb reports, and more — not a generic Python linter with a few Odoo-flavored regexes bolted on.

Everything the extension does — autocomplete, hover, go-to-definition, find references, rename, the ORM performance doctor, the security analyzer, XML and QWeb validation, dependency graphs, impact analysis, migration reports, and optional runtime registry inspection — is powered by **one shared semantic index**. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design.

Made with ❤️ by **Anand Shah** for the developer community.

---

## Why OdooLens?

| Challenge | What OdooLens does |
|-----------|-------------------|
| Dynamic ORM (`self.env['x']`, inheritance, related fields) | Builds a merged model index across modules |
| N+1 searches and loop-bound ORM | ORM Doctor with confidence-scored diagnostics |
| XML fields and buttons that don't exist | Static XML + QWeb validation against the index |
| `sudo()`, public routes, ACL gaps | Security and ACL analyzers |
| Upgrades across 14→19 | Data-driven migration rules with report output |
| "Who calls this method?" | Impact analysis, references, and dependency graphs |

---

## Features

- **Semantic model intelligence** — fields, methods, `_inherit` / `_inherits`, compute/depends, controllers
- **Language features** — completion, hover (with real usage counts), definition, references, symbols, rename
- **ORM Query Doctor** — search/browse/create/write/unlink in loops, nested loops, mapped/filtered patterns, repeated searches, and more
- **Security analyzer** — `sudo()`, unrestricted search, public controller mutations, CSRF, ACL/record rules
- **XML & QWeb validation** — missing fields/methods, XPath targets, duplicate IDs, unresolved refs, version-aware attributes, `t-field` / `t-call`
- **Dead-code hints** — fields, private methods, models, imports, modules, reports, XML IDs (conservative confidence)
- **Dependency & view graphs** — interactive webviews for modules, models, and view inheritance chains
- **Migration assistant** — verified rules for Odoo 14 through 19
- **Impact analysis** — overrides, call sites, XML buttons
- **Log navigator** — paste a traceback, jump to source, aggregate recurring errors
- **Optional runtime registry** — compare static index to a live Odoo instance (credentials via SecretStorage)

---

## Quick start

### From source

```bash
git clone https://github.com/AnandShha10/OdooLens.git
cd odoolens
npm install
npm run compile
npm test
```

Open the folder in VS Code and press **F5** to launch an Extension Development Host with OdooLens active.

Or package and install a `.vsix`:

```bash
npx vsce package
code --install-extension odoolens-*.vsix
```

### Activate on an Odoo project

Open a workspace that contains one or more Odoo modules (any directory with a `__manifest__.py`). OdooLens activates automatically (`workspaceContains:**/__manifest__.py`) and runs an initial workspace analysis.

---

## Supported Odoo versions

The static analyzers (model/field/XML parsing, ORM doctor, security analyzer, XML validator)
are version-agnostic — they work on the Python/XML syntax patterns Odoo has used since v8+.

Version-*aware* behavior lives specifically in the **migration assistant**
(`src/versioning/MigrationRules.ts`), which currently ships verified rules for:

| From | To | Example rules |
|---|---|---|
| 14 | 15 | `@api.multi`/`@api.one` removal, `track_visibility` → `tracking` |
| 15 | 16 | `args=` renamed to `domain=` on `search()`/`search_count()`/`_search()`, `fields_get_keys()`/`get_xml_id()` deprecated, `_mapped_cache()` removed, `Model._sequence` removed, `Field.column_format`/`Field.deprecated` removed |
| 16 | 17 | `name_get()` deprecation warning, `attrs="..."` view syntax deprecation |
| 17 | 18 | `<tree>` → `<list>` view tag and `view_mode` `tree` → `list` (XML and Python action dicts), `sudo(True/False)` boolean-argument deprecation, `check_access_rights()`/`check_access_rule()` superseded by unified `check_access()` |
| 18 | 19 | `read_group()` deprecated in favor of `_read_group()`/`formatted_read_group()`, legacy `odoo.osv` import path deprecated, `self._cr`/`self._uid`/`self._context` deprecated in favor of `self.env.cr`/`self.env.uid`/`self.env.context` |

Every rule above was sourced from Odoo's official ORM changelog
(odoo.com/documentation/.../developer/reference/backend/orm/changelog.html) with a PR reference,
not inferred from memory — each rule's `documentationUrl` points at the specific page.

Set `odooIntelligence.odooVersion` to a specific version, or leave it `"auto"`. New rules are
added as plain data entries in `MigrationRules.ts`, never as ad-hoc logic — see
`CONTRIBUTING.md`.

## Configuration

All settings live under the `odooIntelligence.*` namespace (see `package.json` →
`contributes.configuration` for the authoritative list). Highlights:

- `odooIntelligence.addonsPaths` — extra addons paths to scan (relative to the first workspace
  folder, or absolute), beyond the open workspace folders themselves — e.g. a separate
  `enterprise/` or `custom-addons/` checkout.
- `odooIntelligence.odooVersion` — `"auto"` (default) auto-detects the workspace's Odoo version
  from module manifests' `version` fields and uses it as the default "from" version in `Odoo:
  Generate Migration Report`; set a specific version (e.g. `"17"`) to skip that prompt entirely.
- `odooIntelligence.enableORMDoctor` / `enableSecurityAnalyzer` / `enableXMLAnalyzer` /
  `enableDeadCodeAnalyzer` / `enableMigrationAnalyzer` / `enableRuntimeRegistry` — per-analyzer
  toggles. `enableMigrationAnalyzer`/`enableRuntimeRegistry` gate their respective commands
  directly (they'll tell you they're disabled rather than silently doing nothing).
- `odooIntelligence.logLevel` — `error` | `warning` | `information` (default) | `hint`; controls
  how much OdooLens writes to the "OdooLens" output channel. Set to `error` to silence routine
  "indexed N modules" logging and keep only real failures.
- `odooIntelligence.ormDoctor.rules` — an object map to disable individual ORM Doctor rules
  (e.g. `{"search-in-loop": false}`).
- `odooIntelligence.security.rules` — per-code-pattern toggles (`sudo-bypass`,
  `unrestricted-search`, `public-controller-mutation`, `csrf-disabled-route`,
  `sudo-mutation-without-auth-check`).
- `odooIntelligence.security.aclRules` — per-configuration-check toggles for the ACL/record-rule
  analyzer (`no-access-rule-defined`, `dangling-access-rule-model`, `acl-write-without-read`,
  `permissive-record-rule`).
- `odooIntelligence.deadCode.minConfidence` — `definitely_unused` | `probably_unused` |
  `unknown`; OdooLens currently never emits `definitely_unused` (see Limitations).

## Commands

| Command | What it does |
|---|---|
| `Odoo: Analyze Workspace` / `Odoo: Rebuild Index` | Full workspace scan: discovers modules, parses every `.py`/`.xml`/`ir.model.access.csv`, builds the merged model index, runs all analyzers. Python analyses are cached across sessions (see below) — a repeat scan of an unchanged workspace should be noticeably faster than the first one. |
| `Odoo: Clear Index Cache` | Deletes the persistent cache so the next rebuild re-parses every Python file from scratch. Shouldn't normally be needed (file-mtime invalidation handles changes automatically) — here as a manual escape hatch. |
| `Odoo: Show Model` | Webview listing every field/method on a chosen model, with declaring module + file. |
| `Odoo: Show Field Intelligence` | Field-level detail: type, compute/depends chain, declaration history across modules, static usage counts. Works from the cursor position or via picker. |
| `Odoo: Find Field Usages` | Opens VS Code's built-in "references" peek view for a chosen field's statically-discovered usages. |
| `Odoo: Go to Field Definition` | Jumps straight to a field's declaring source line. |
| `Odoo: Show Dependency Graph` | Interactive pan/zoom/click SVG graph, three modes: module dependency graph; per-model relationship graph (contributing modules, related comodels, views); or the **unified model graph** — one graph spanning every field, method, view, scheduled action (`ir.cron`), server action, and security rule (`ir.model.access.csv` + `ir.rule`) for a model, grouped under category nodes. |
| `Odoo: Show View Inheritance` | Resolves a chosen base view's full `<xpath>`/position inheritance chain into an effective tree, with per-node provenance badges and unresolved-target warnings. |
| `Odoo: Analyze Impact` | For a model method, shows override history, direct Python call sites, and XML button references — all from the shared index. |
| `Odoo: Generate Migration Report` | Scans every indexed Python file against the structured migration rule set for a chosen version range. |
| `Odoo: Connect to Runtime` / `Odoo: Inspect Runtime Registry` | Optional live-server comparison (see below). |
| `Odoo: Analyze Odoo Log` | Parses a pasted/opened server log into structured, de-duplicated error occurrences. |

Beyond commands, OdooLens also registers standard VS Code language features you don't need a
command for: **completion**/**hover**/**go-to-definition** (Python), a **workspace symbol
provider** (Ctrl+T / Cmd+T — search for any indexed model/field/method by name), a
**CodeActionProvider** (lightbulb quick fixes for ORM Doctor findings + "learn more" links), and
a **rename provider** (F2 on a field, a method, or a model-name string — see Limitations below
for exactly what each of the three does and deliberately does not rename).

## Sidebar explorers

OdooLens adds an **OdooLens** icon to the activity bar with three tree views, all refreshing
automatically as the index or diagnostics change:

- **Models** — every indexed model, expandable into its Fields (with type/comodel) and Methods
  (with decorators); click any node to jump to its declaration.
- **Modules** — modules in dependency order, expandable into the models each contributes to and
  the modules it depends on (dependencies outside the workspace are marked).
- **Problems** — OdooLens's own findings grouped by *category* (security first), unlike VS
  Code's built-in Problems panel which groups by file. Hover a finding for its message and
  confidence level.

## Example diagnostics

**ORM Doctor** (`search-in-loop`):
```
⚠ Possible N+1 ORM query: search() executes once per loop iteration. Consider batching:
collect the relevant IDs first, then run a single search() with an 'in' domain outside
the loop. [medium confidence]
```

**XML validator** (`xml-field-not-found`):
```
Field "customer_score" does not exist on model "sale.order" (as resolved by the static
index). If this field is added dynamically or by a module outside the current workspace,
this may be a false positive. [high confidence]
```

**Security analyzer** (`sudo-bypass`):
```
sudo() bypasses normal record rules and access rights for every ORM call chained after it.
Verify that the intended authorization scope is deliberate and as narrow as possible.
[medium confidence]
```

**Security analyzer, auth-escalated** (`sudo-bypass` from a public route):
```
sudo() is called from a route with auth='public' — this combination (unauthenticated caller
+ elevated ORM privileges) is the classic shape of an access-control vulnerability. Verify
every ORM call between here and the route's mutations is scoped as narrowly as possible.
[high confidence]
```

**ACL analyzer** (`no-access-rule-defined`):
```
Model "custom_sale.log" has no ir.model.access.csv row anywhere in the indexed workspace.
Without an access rule, users typically cannot read/write this model at all (Odoo defaults
to no access). [medium confidence]
```

## Runtime integration (optional)

OdooLens works fully offline from the static index. Optionally, it can compare that against a
**live** Odoo server's registry: install the companion module in `odoo-helper/` (see its
README — copy `odoolens_helper/` into an addons path, set the `odoolens.api_token` system
parameter), enable `odooIntelligence.enableRuntimeRegistry`, then run `Odoo: Connect to
Runtime`. `Odoo: Inspect Runtime Registry` then shows STATIC INDEX vs RUNTIME REGISTRY for a
model side by side. The token lives in VS Code `SecretStorage` only — never logged, never in
settings. The helper is read-only, refuses every request until a token is configured, and is
meant for development/staging databases. No telemetry is sent anywhere by default.

The VS Code client and the helper's introspection logic are both tested (against a fake HTTP
endpoint and plain-Python fakes respectively), but the helper's thin Odoo controller has not
been run against a real Odoo server in this project's build environment — treat a first real
connection as the final verification step.

## Known limitations (read this before trusting a diagnostic blindly)

OdooLens is upfront about where static analysis cannot be perfect — see
`ARCHITECTURE.md § Limitations` for the full list. In short:

- **No full type inference.** `self.env['x.y']` and `self.` inside a known model's method are
  resolved with high confidence; an arbitrary local variable is resolved only via a one-hop
  heuristic (`var = self.env[...]`, or `for x in var`). Anything else yields *no* completion
  rather than a guess.
- **XPath support is a practical subset**: `//tag[@attr='value']` and shorthand
  `position="..."` patches. General XPath axes/functions are not implemented.
- **Usage/reference counts follow multi-hop attribute chains, multi-segment for-loop iterables,
  and CHAINS of type-preserving method calls** (`self.partner_id.name`,
  `for child in self.partner_id.child_ids:`, `var = var.filtered(...).sorted(...).exists()`,
  `var = var.mapped('child_ids')`) — still not full type inference. See `ARCHITECTURE.md §
  Reference/usage counting` for the whitelisted method set and exactly what remains unresolved.
- **Dead-code findings never claim "definitely unused"** — only `probably_unused` or `unknown`.
- **Incremental indexing recomputes only the affected models** on each file save (debounced) —
  both the merged model index (`incrementalRebuildModels()`) and the cross-file reference index
  (`buildReferenceIndex(onlyModels)`) are scoped to the models the changed file's contributions
  or views actually touch, leaving every other model's data untouched.
- **Impact analysis** follows direct `self.method(...)` calls, XML `<button>` references, and
  (via a text search) `ir.cron` / `ir.actions.server` `code` fields — but not dynamic dispatch
  (`getattr`, etc.). It cannot enumerate actual *external* RPC callers (that's unknowable from
  source code alone); instead it reports the concrete static fact it CAN know — whether the
  method is RPC-*reachable* at all (public name with no `@api.private`).
- **Rename covers three symbol kinds, each scoped to only what OdooLens can pinpoint exactly**:
  - **Field**: every declaration site across inheriting modules, plus any XML
    `<field name="...">` usage on a view whose model matches.
  - **Method**: every declaration/override site, plus any XML `<button name="..."
    type="object">` reference. Does NOT rename `self.method_name()` call sites (OdooLens tracks
    that such calls exist, but not their exact source location).
  - **Model** (F2 on a model-name string, e.g. inside `_name = "..."` or `self.env['...']`):
    every `_name`/`_inherit` string-literal contents and every `self.env['...']` string. Does
    NOT rename XML `<field name="model">`, `ir.model.access.csv` rows or their `model_<name>`
    external-id convention, or other cross-references — model rename has a much larger blast
    radius (a mismatched external id can break module installation), so you're told to search
    for the old name and finish the rest by hand.
  None of the three rename Python attribute access or domain tuples, since those come from the
  best-effort reference index rather than exact AST locations.
- **The `npm run test:integration` VS Code integration suite** needs normal internet access on
  first run (to download a VS Code test binary) — see `ARCHITECTURE.md § Testing strategy` if
  it fails inside a network-restricted sandbox/CI image.

## Troubleshooting

- **"No models found"**: confirm the open folder (or a subfolder within `addonsPaths`) actually
  contains `__manifest__.py` files, and run `Odoo: Rebuild Index` manually.
- **A field/method shows as missing but you know it exists**: it's likely declared in a module
  that isn't inside your current workspace (e.g. Odoo core `sale`, `stock`, etc.). OdooLens only
  indexes what it can see; add the missing addons path via `odooIntelligence.addonsPaths` if
  it's on disk, and re-run "Rebuild Index".
- **Parsing seems to skip a file**: check the "OdooLens" output channel — malformed Python/XML
  is logged and skipped rather than crashing the extension.
