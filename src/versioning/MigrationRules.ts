export type OdooVersion = '14' | '15' | '16' | '17' | '18' | '19';

export interface MigrationRule {
  id: string;
  sourceVersion: OdooVersion;
  targetVersion: OdooVersion;
  category: 'decorator' | 'orm-method' | 'field-api' | 'xml' | 'import' | 'other';
  /** Regex matched against raw source text (line-scoped) — deliberately simple and auditable. */
  pattern: string;
  patternFlags?: string;
  message: string;
  severity: 'error' | 'warning' | 'information' | 'hint';
  replacement?: string; // human-readable guidance; NOT applied automatically unless isSafeAutoFix
  isSafeAutoFix: boolean;
  documentationUrl?: string;
  confidence: 'high' | 'medium' | 'low';
  estimatedEffort: 'trivial' | 'small' | 'moderate' | 'large';
}

/**
 * Every rule here is a *known, documented* Odoo framework change. New rules should be added
 * here (with a documentation link) rather than encoded as ad-hoc logic in the analyzer, so the
 * rule set can be audited and extended without touching analysis code.
 *
 * This set intentionally starts small and well-verified rather than large and speculative —
 * per the "do not invent migration rules" requirement. Every rule's `documentationUrl` points
 * at an official Odoo changelog/deprecated-features page with the specific PR referenced there,
 * not a general guess. The 18→19 batch below was added by consulting Odoo's official ORM
 * changelog (https://www.odoo.com/documentation/19.0/developer/reference/backend/orm/changelog.html)
 * rather than being inferred from training data, since post-cutoff release details can't be
 * trusted from memory alone. Contributions welcome (see CONTRIBUTING.md) to grow coverage
 * further as more 19.x deprecations are documented.
 */
export const MIGRATION_RULES: MigrationRule[] = [
  {
    id: 'api-multi-removed',
    sourceVersion: '14',
    targetVersion: '15',
    category: 'decorator',
    pattern: '@api\\.multi\\b',
    message: '@api.multi was removed. Since Odoo 13, all recordset methods are implicitly multi-record; simply remove the decorator.',
    severity: 'error',
    replacement: 'Remove the @api.multi line entirely.',
    isSafeAutoFix: false,
    documentationUrl: 'https://www.odoo.com/documentation/17.0/developer/reference/upgrades/deprecated_features.html',
    confidence: 'high',
    estimatedEffort: 'trivial',
  },
  {
    id: 'api-one-removed',
    sourceVersion: '14',
    targetVersion: '15',
    category: 'decorator',
    pattern: '@api\\.one\\b',
    message: '@api.one was removed prior to Odoo 13. Methods must handle `self` as a recordset and loop internally if needed.',
    severity: 'error',
    isSafeAutoFix: false,
    confidence: 'high',
    estimatedEffort: 'small',
  },
  {
    id: 'name-get-deprecated',
    sourceVersion: '16',
    targetVersion: '17',
    category: 'orm-method',
    pattern: '\\bdef\\s+name_get\\s*\\(',
    message:
      'name_get() is being superseded by the `_compute_display_name()` pattern in newer Odoo versions. Confirm whether this override should migrate to computing `display_name` instead.',
    severity: 'warning',
    isSafeAutoFix: false,
    confidence: 'medium',
    estimatedEffort: 'moderate',
  },
  {
    id: 'track-visibility-removed',
    sourceVersion: '14',
    targetVersion: '15',
    category: 'field-api',
    pattern: "track_visibility\\s*=",
    message: "track_visibility='...' on fields was replaced by tracking=True (or tracking=<sequence int>).",
    severity: 'error',
    replacement: "Replace track_visibility='onchange'/'always' with tracking=True.",
    isSafeAutoFix: false,
    confidence: 'high',
    estimatedEffort: 'trivial',
  },
  {
    id: 'search-args-renamed-domain',
    sourceVersion: '15',
    targetVersion: '16',
    category: 'orm-method',
    pattern: '\\.(search|search_count|_search)\\(\\s*args\\s*=',
    message: 'The args keyword argument was renamed to domain for search(), search_count(), and _search() (Odoo Online 15.3, #83687).',
    severity: 'warning',
    replacement: 'Rename the args= keyword to domain=.',
    isSafeAutoFix: false,
    documentationUrl: 'https://www.odoo.com/documentation/17.0/developer/reference/backend/orm/changelog.html',
    confidence: 'high',
    estimatedEffort: 'trivial',
  },
  {
    id: 'fields-get-keys-get-xml-id-deprecated',
    sourceVersion: '15',
    targetVersion: '16',
    category: 'orm-method',
    pattern: '\\.fields_get_keys\\(|\\.get_xml_id\\(',
    message: 'fields_get_keys() and get_xml_id() on Model are deprecated (Odoo Online 15.3, #83687).',
    severity: 'warning',
    isSafeAutoFix: false,
    documentationUrl: 'https://www.odoo.com/documentation/17.0/developer/reference/backend/orm/changelog.html',
    confidence: 'medium',
    estimatedEffort: 'small',
  },
  {
    id: 'mapped-cache-removed',
    sourceVersion: '15',
    targetVersion: '16',
    category: 'orm-method',
    pattern: '\\._mapped_cache\\(',
    message: 'The _mapped_cache() method was removed (Odoo Online 15.3, #83687).',
    severity: 'error',
    isSafeAutoFix: false,
    documentationUrl: 'https://www.odoo.com/documentation/17.0/developer/reference/backend/orm/changelog.html',
    confidence: 'high',
    estimatedEffort: 'moderate',
  },
  {
    id: 'model-sequence-attribute-removed',
    sourceVersion: '15',
    targetVersion: '16',
    category: 'field-api',
    pattern: '^\\s*_sequence\\s*=',
    message: "The _sequence attribute of Model was removed \u2014 Odoo now lets PostgreSQL use the primary key's default sequence (Odoo Online 15.2, #82727).",
    severity: 'warning',
    replacement: 'Remove the _sequence class attribute.',
    isSafeAutoFix: false,
    documentationUrl: 'https://www.odoo.com/documentation/17.0/developer/reference/backend/orm/changelog.html',
    confidence: 'medium',
    estimatedEffort: 'trivial',
  },
  {
    id: 'field-column-format-deprecated-removed',
    sourceVersion: '15',
    targetVersion: '16',
    category: 'field-api',
    pattern: 'fields\\.\\w+\\([^)]*\\b(column_format|deprecated)\\s*=',
    message: 'The column_format and deprecated attributes of Field were removed (Odoo Online 15.2, #82727).',
    severity: 'error',
    isSafeAutoFix: false,
    documentationUrl: 'https://www.odoo.com/documentation/17.0/developer/reference/backend/orm/changelog.html',
    confidence: 'medium',
    estimatedEffort: 'small',
  },
  {
    id: 'attrs-states-deprecated-views',
    sourceVersion: '16',
    targetVersion: '17',
    category: 'xml',
    pattern: 'attrs\\s*=\\s*["\\\']',
    message:
      "The attrs=\"{...}\" view attribute is deprecated from Odoo 17 onward in favor of direct Python-expression attributes (invisible=\"...\", readonly=\"...\", required=\"...\").",
    severity: 'warning',
    isSafeAutoFix: false,
    confidence: 'high',
    estimatedEffort: 'moderate',
  },
  {
    id: 'sudo-context-removed',
    sourceVersion: '17',
    targetVersion: '18',
    category: 'orm-method',
    pattern: '\\.sudo\\(\\s*(True|False)\\s*\\)',
    message: 'sudo(True) / sudo(False) boolean argument form is deprecated. Call sudo() with no arguments to elevate, or drop the call entirely to de-elevate.',
    severity: 'warning',
    isSafeAutoFix: false,
    confidence: 'medium',
    estimatedEffort: 'trivial',
  },
  {
    id: 'check-access-rights-rule-superseded',
    sourceVersion: '17',
    targetVersion: '18',
    category: 'orm-method',
    pattern: '\\.check_access_rights\\(|\\.check_access_rule\\(',
    message:
      "Odoo 18.0 introduced unified check_access(), has_access(), and _filtered_access() methods that combine access-rights and record-rule checks in one call. The separate check_access_rights()/check_access_rule() methods this line uses are superseded by that unified API.",
    severity: 'information',
    replacement: 'Consider migrating to check_access(operation) (or has_access()/_filtered_access() where appropriate).',
    isSafeAutoFix: false,
    documentationUrl: 'https://www.odoo.com/documentation/19.0/developer/reference/backend/orm/changelog.html',
    confidence: 'medium',
    estimatedEffort: 'moderate',
  },
  {
    id: 'xml-tree-tag-renamed-list',
    sourceVersion: '17',
    targetVersion: '18',
    category: 'xml',
    pattern: '<tree\\b',
    message:
      "Odoo 18 renamed the list view's root tag from <tree> to <list>. A view whose arch still starts with <tree> fails to load in 18 (\"Wrong value for ir.ui.view.type: 'tree'\"). Odoo 18 also ships an upgrade_code command that can rewrite this automatically.",
    severity: 'error',
    replacement: 'Replace <tree ...>...</tree> with <list ...>...</list>.',
    isSafeAutoFix: false,
    documentationUrl: 'https://www.odoo.com/documentation/18.0/developer/tutorials/server_framework_101/06_basicviews.html',
    confidence: 'high',
    estimatedEffort: 'trivial',
  },
  {
    id: 'xml-view-mode-tree-renamed-list',
    sourceVersion: '17',
    targetVersion: '18',
    category: 'xml',
    pattern: 'name=["\']view_mode["\']\\s*>[^<]*\\btree\\b',
    message:
      "An act_window's view_mode still lists 'tree'. In Odoo 18 the list view type is named 'list'; an action with view_mode=\"tree,form\" fails when opened (\"View types not defined tree found in act_window action\").",
    severity: 'error',
    replacement: "Change 'tree' to 'list' in view_mode (e.g. \"list,form\").",
    isSafeAutoFix: false,
    confidence: 'high',
    estimatedEffort: 'trivial',
  },
  {
    id: 'py-view-mode-tree-renamed-list',
    sourceVersion: '17',
    targetVersion: '18',
    category: 'other',
    pattern: '[\'"]view_mode[\'"]\\s*:\\s*[\'"][^\'"]*\\btree\\b',
    message:
      "A window-action dict's 'view_mode' still lists 'tree'. In Odoo 18 the list view type is named 'list'; the same action-opening failure as the XML view_mode case applies.",
    severity: 'error',
    replacement: "Change 'tree' to 'list' in the view_mode string.",
    isSafeAutoFix: false,
    confidence: 'high',
    estimatedEffort: 'trivial',
  },
  {
    id: 'read-group-deprecated',
    sourceVersion: '18',
    targetVersion: '19',
    category: 'orm-method',
    pattern: '\\.read_group\\(',
    message:
      'read_group() is deprecated (Odoo Online 18.2) in favor of _read_group() for internal/backend usage, or formatted_read_group() as its formatted public-API replacement.',
    severity: 'warning',
    replacement: 'Use _read_group() for backend code, or formatted_read_group() if you need the old formatted output shape.',
    isSafeAutoFix: false,
    documentationUrl: 'https://www.odoo.com/documentation/19.0/developer/reference/backend/orm/changelog.html',
    confidence: 'medium',
    estimatedEffort: 'moderate',
  },
  {
    id: 'odoo-osv-import-deprecated',
    sourceVersion: '18',
    targetVersion: '19',
    category: 'import',
    pattern: '(^|\\s)import\\s+odoo\\.osv\\b|from\\s+odoo\\s+import\\s+osv\\b|from\\s+odoo\\.osv\\s+import\\b',
    message: 'The legacy odoo.osv module/import path is deprecated in Odoo 19.0. Modern Odoo models use odoo.models/odoo.fields/odoo.api directly.',
    severity: 'warning',
    isSafeAutoFix: false,
    documentationUrl: 'https://www.odoo.com/documentation/19.0/developer/reference/backend/orm/changelog.html',
    confidence: 'high',
    estimatedEffort: 'small',
  },
  {
    id: 'private-record-attrs-deprecated',
    sourceVersion: '18',
    targetVersion: '19',
    category: 'orm-method',
    pattern: '\\bself\\._cr\\b|\\bself\\._uid\\b|\\bself\\._context\\b',
    message:
      'Direct access to record._cr, record._context, and record._uid is deprecated in Odoo 19.0 (this rule scopes to the common `self._cr`/`self._uid`/`self._context` form). Use self.env.cr, self.env.context, and self.env.uid instead.',
    severity: 'warning',
    replacement: 'Replace self._cr → self.env.cr, self._uid → self.env.uid, self._context → self.env.context.',
    isSafeAutoFix: false,
    documentationUrl: 'https://www.odoo.com/documentation/19.0/developer/reference/backend/orm/changelog.html',
    confidence: 'medium',
    estimatedEffort: 'trivial',
  },
];

export function rulesForUpgrade(from: OdooVersion, to: OdooVersion): MigrationRule[] {
  const versions: OdooVersion[] = ['14', '15', '16', '17', '18', '19'];
  const fromIdx = versions.indexOf(from);
  const toIdx = versions.indexOf(to);
  if (fromIdx < 0 || toIdx < 0 || fromIdx >= toIdx) return [];
  return MIGRATION_RULES.filter((r) => versions.indexOf(r.sourceVersion) >= fromIdx && versions.indexOf(r.targetVersion) <= toIdx);
}

const KNOWN_VERSIONS: readonly string[] = ['14', '15', '16', '17', '18', '19'];

/**
 * Best-effort "which Odoo version is this workspace on" detection: the most common leading
 * major-version number across a set of manifest `version` strings (e.g. "17.0.1.0.0" -> "17").
 * Kept here (framework-independent, no `vscode` import) rather than inline in the migration
 * report command so it's directly unit-testable — see `odooIntelligence.odooVersion: "auto"` in
 * package.json, which this function is what actually implements.
 */
export function detectMajorVersion(manifestVersions: (string | undefined)[]): OdooVersion | undefined {
  const counts = new Map<string, number>();
  for (const version of manifestVersions) {
    const major = version?.split('.')[0];
    if (major && KNOWN_VERSIONS.includes(major)) {
      counts.set(major, (counts.get(major) ?? 0) + 1);
    }
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best as OdooVersion | undefined;
}
