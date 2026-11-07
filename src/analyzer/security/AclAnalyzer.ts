import { OdooDiagnostic } from '../../semantic/OdooTypes';
import { OdooWorkspaceIndex } from '../../index/OdooIndex';

export interface AclRuleConfig {
  'no-access-rule-defined'?: boolean;
  'dangling-access-rule-model'?: boolean;
  'acl-write-without-read'?: boolean;
  'permissive-record-rule'?: boolean;
}

/**
 * Widens security coverage from "suspicious code patterns" (SecurityAnalyzer.ts) to
 * "suspicious/inconsistent access-control CONFIGURATION" — reading `ir.model.access.csv` rows
 * and `<record model="ir.rule">` entries against the merged model index. This directly targets
 * the two gaps called out as missing from the original build: ACL-mismatch detection (a model
 * with no access row at all, or an access row pointing at a model that doesn't exist) and a
 * first pass at record-rule (row-level security) sanity checking.
 *
 * Every finding here is conservative by necessity: OdooLens cannot see which access rows exist
 * in modules outside the current workspace (e.g. Odoo core's own `sale.csv` granting access to
 * `sale.order`), so "no access rule found" is reported at low/medium confidence, never as a
 * certainty, and is scoped to only models this workspace actually DEFINES (some contribution
 * has a matching `_name = "..."`) — a model only ever extended here via `_inherit` of an
 * out-of-workspace base (e.g. `res.partner`) is skipped entirely, since its real access row
 * lives wherever it's actually defined, not in this workspace.
 */
export function runAclAnalyzer(index: OdooWorkspaceIndex, config: AclRuleConfig): OdooDiagnostic[] {
  const diagnostics: OdooDiagnostic[] = [];

  const modelToXmlSuffix = (model: string) => `model_${model.replace(/\./g, '_')}`;
  const knownModelSuffixes = new Set(Array.from(index.models.keys()).map(modelToXmlSuffix));

  // --- dangling-access-rule-model: a CSV row's model_id doesn't match any indexed model ---
  if (config['dangling-access-rule-model'] !== false) {
    for (const row of index.accessRules) {
      const suffix = row.modelId.includes('.') ? row.modelId.split('.').pop()! : row.modelId;
      if (!suffix.startsWith('model_')) continue; // not the expected external-id convention; skip rather than guess
      if (knownModelSuffixes.has(suffix)) continue;
      diagnostics.push({
        ruleId: 'dangling-access-rule-model',
        message: `Access rule "${row.name || row.id}" references model_id "${row.modelId}", which doesn't match any model OdooLens indexed in this workspace. This may be a typo, or the model may be defined in a module outside the current workspace/addons paths.`,
        severity: 'warning',
        confidence: 'low',
        location: { file: row.file, startLine: row.line, startCol: 0, endLine: row.line, endCol: 0 },
        category: 'security',
        fixes: [],
      });
    }
  }

  // --- acl-write-without-read: granting write/create/unlink without read is a known ACL smell ---
  if (config['acl-write-without-read'] !== false) {
    for (const row of index.accessRules) {
      const hasMutatePerm = row.permWrite || row.permCreate || row.permUnlink;
      if (hasMutatePerm && !row.permRead) {
        diagnostics.push({
          ruleId: 'acl-write-without-read',
          message: `Access rule "${row.name || row.id}" grants write/create/unlink permission without read permission. This is unusual — without read access the group generally can't select the records they'd be writing/creating/deleting, which often indicates a misconfigured CSV row (columns shifted, or perm_read accidentally left at 0).`,
          severity: 'warning',
          confidence: 'medium',
          location: { file: row.file, startLine: row.line, startCol: 0, endLine: row.line, endCol: 0 },
          category: 'security',
          fixes: [],
        });
      }
    }
  }

  // --- no-access-rule-defined: a model this workspace defines has zero access rows anywhere ---
  if (config['no-access-rule-defined'] !== false) {
    const modelsWithAccessRow = new Set<string>();
    for (const row of index.accessRules) {
      const suffix = row.modelId.includes('.') ? row.modelId.split('.').pop()! : row.modelId;
      if (suffix.startsWith('model_')) modelsWithAccessRow.add(suffix);
    }
    for (const [modelName, model] of index.models) {
      if (model.isTransient || model.isAbstract) continue; // typically don't need their own ACL row
      // Only flag models this workspace actually DEFINES (some contribution has `_name = "..."`
      // matching this model) — a model only ever extended here via `_inherit` of an
      // out-of-workspace base (e.g. `res.partner`, whose real `_name` declaration lives in Odoo
      // core) is not this workspace's responsibility to grant access for, and almost always
      // already has an access row in whatever module actually defines it.
      const isDefinedHere = model.contributions.some((c) => c.name === modelName);
      if (!isDefinedHere) continue;
      const firstContribution = model.contributions.find((c) => c.name === modelName)!;
      const suffix = modelToXmlSuffix(modelName);
      if (modelsWithAccessRow.has(suffix)) continue;
      diagnostics.push({
        ruleId: 'no-access-rule-defined',
        message: `Model "${modelName}" has no ir.model.access.csv row anywhere in the indexed workspace. Without an access rule, users typically cannot read/write this model at all (Odoo defaults to no access). If this is intentional (e.g. an abstract mixin, or access is granted by a module outside this workspace), this is a false positive — otherwise, add an ir.model.access.csv row.`,
        severity: 'warning',
        confidence: 'medium',
        location: firstContribution.location,
        category: 'security',
        fixes: [],
      });
    }
  }

  // --- permissive-record-rule: a global (no groups) ir.rule with an empty/trivial domain ---
  if (config['permissive-record-rule'] !== false) {
    for (const rule of index.ruleRecords) {
      if (!rule.isGlobal) continue; // scoped to specific groups — a global-only smell
      const domain = (rule.domainForce ?? '').replace(/\s+/g, '');
      const isTrivial = domain === '' || domain === '[]' || domain === "[(1,'=',1)]" || domain === '[(1,"=",1)]';
      if (!isTrivial) continue;
      diagnostics.push({
        ruleId: 'permissive-record-rule',
        message: `Record rule "${rule.name || rule.xmlId}" applies globally (no groups restrict it) with an empty/always-true domain ("${rule.domainForce ?? ''}"). A global rule with a trivial domain provides no actual row-level restriction — confirm this is intentional (e.g. deliberately overriding a more restrictive rule from a base module) rather than a placeholder left over from development.`,
        severity: 'information',
        confidence: 'medium',
        location: rule.location,
        category: 'security',
        fixes: [],
      });
    }
  }

  return diagnostics;
}
