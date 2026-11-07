import { OdooDiagnostic } from '../../semantic/OdooTypes';
import { OdooWorkspaceIndex } from '../../index/OdooIndex';

export type DeadCodeConfidence = 'definitely_unused' | 'probably_unused' | 'unknown';

const CONFIDENCE_RANK: Record<DeadCodeConfidence, number> = {
  definitely_unused: 3,
  probably_unused: 2,
  unknown: 1,
};

const NEVER_FLAG_FIELDS = new Set([
  'active', 'name', 'sequence', 'state', 'company_id', 'currency_id',
  'message_follower_ids', 'message_ids', 'activity_ids',
]);

const ORM_HOOKS = new Set([
  'create', 'write', 'unlink', 'copy', 'default_get', 'name_get', 'name_search',
  'fields_get', 'read_group', '_read_group', 'search', '_search', 'init',
  '_register_hook', '_auto_init', '_name_search', '_get_view', '_valid_field_parameter',
]);

function isOrmHookName(name: string): boolean {
  if (ORM_HOOKS.has(name)) return true;
  if (name.startsWith('_compute_') || name.startsWith('_inverse_') || name.startsWith('_search_')) return true;
  if (name.startsWith('_onchange_') || name.startsWith('_check_')) return true;
  return false;
}

function isModelFullyInWorkspace(index: OdooWorkspaceIndex, modelName: string): boolean {
  const model = index.getModel(modelName);
  if (!model || model.contributions.length === 0) return false;
  for (const mod of model.modules) {
    if (!index.modules.has(mod)) return false;
  }
  return true;
}

/**
 * Conservative dead-code analysis for fields, private methods, models, views, XML IDs,
 * cron jobs, and server actions. Never claims "definitely unused" for Odoo dynamic patterns.
 */
export function runDeadCodeAnalyzer(index: OdooWorkspaceIndex, minConfidence: DeadCodeConfidence): OdooDiagnostic[] {
  const diagnostics: OdooDiagnostic[] = [];

  // ---- Fields + private methods ----
  for (const [modelName, model] of index.models) {
    for (const [fieldName, field] of model.fields) {
      if (NEVER_FLAG_FIELDS.has(fieldName)) continue;
      const usages = index.references.getFieldUsages(modelName, fieldName);
      if (usages.length > 0) continue;
      const confidence: DeadCodeConfidence = field.related ? 'unknown' : 'probably_unused';
      if (CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[minConfidence]) continue;
      diagnostics.push({
        ruleId: 'dead-code-unused-field',
        message: `Field "${fieldName}" on model "${modelName}" has no statically-discovered Python or XML references. Verify manually before removing — "${confidence}" confidence.`,
        severity: 'hint',
        confidence: confidence === 'unknown' ? 'low' : 'medium',
        location: field.location,
        category: 'deadCode',
        fixes: [],
      });
    }

    if (!isModelFullyInWorkspace(index, modelName)) continue;

    const called = new Set<string>();
    for (const [, m] of model.methods) {
      for (const callee of m.calledMethods) called.add(callee);
    }

    for (const [methodName, methodDecl] of model.methods) {
      if (!methodName.startsWith('_') || methodName.startsWith('__')) continue;
      if (isOrmHookName(methodName)) continue;
      if (called.has(methodName)) continue;
      if (methodDecl.isCompute) continue;
      const isBoundToField = Array.from(model.fields.values()).some(
        (f) => f.compute === methodName || f.inverse === methodName || f.search === methodName
      );
      if (isBoundToField) continue;
      if (CONFIDENCE_RANK['probably_unused'] < CONFIDENCE_RANK[minConfidence]) continue;
      diagnostics.push({
        ruleId: 'dead-code-unused-private-method',
        message: `Private method "${methodName}" on model "${modelName}" has no statically-discovered callers. Dynamic dispatch may still reach it — "${'probably_unused'}" confidence.`,
        severity: 'hint',
        confidence: 'medium',
        location: methodDecl.nameLocation ?? methodDecl.location,
        category: 'deadCode',
        fixes: [],
      });
    }
  }

  // ---- Models with zero references (no views, no env access, no field/model usages) ----
  if (CONFIDENCE_RANK['probably_unused'] >= CONFIDENCE_RANK[minConfidence]) {
    for (const [modelName, model] of index.models) {
      if (!isModelFullyInWorkspace(index, modelName)) continue;
      // Skip abstract / transient framework-ish models
      if (model.isAbstract) continue;
      const modelUsages = index.references.getModelUsages(modelName);
      const hasView = Array.from(index.viewsById.values()).some((v) => v.model === modelName);
      const hasAccess = index.accessRules.some((r) => r.modelId === 'model_' + modelName.replace(/\./g, '_'));
      const hasRule = index.ruleRecords.some((r) => r.model === modelName);
      if (modelUsages.length > 0 || hasView || hasAccess || hasRule) continue;
      // Also check whether any other model field points at this as comodel
      let usedAsComodel = false;
      for (const [, other] of index.models) {
        for (const [, f] of other.fields) {
          if (f.comodel === modelName) { usedAsComodel = true; break; }
        }
        if (usedAsComodel) break;
      }
      if (usedAsComodel) continue;
      const loc = model.contributions[0]?.location;
      if (!loc) continue;
      diagnostics.push({
        ruleId: 'dead-code-unused-model',
        message: `Model "${modelName}" has no statically-discovered views, access rules, record rules, env lookups, or incoming relational fields. May still be used dynamically — "probably_unused" confidence.`,
        severity: 'hint',
        confidence: 'low',
        location: loc,
        category: 'deadCode',
        fixes: [],
      });
    }
  }

  // ---- Views never inherited and never an action target (heuristic: no inherit children, not referenced as inherit_id) ----
  if (CONFIDENCE_RANK['unknown'] >= CONFIDENCE_RANK[minConfidence]) {
    const inheritedTargets = new Set<string>();
    for (const v of index.viewsById.values()) {
      if (v.inheritId) inheritedTargets.add(v.inheritId);
    }
    for (const [xmlId, view] of index.viewsById) {
      if (view.inheritId) continue; // extension views are intentional
      if (inheritedTargets.has(xmlId)) continue;
      // Primary views are usually intentional even without children; only flag when model is also unused-ish
      // Keep this very low noise: skip for now unless no model binding
      if (!view.model) {
        diagnostics.push({
          ruleId: 'dead-code-orphan-view',
          message: `View "${xmlId}" has no model binding and is not an inheritance target. May be unused — "unknown" confidence.`,
          severity: 'hint',
          confidence: 'low',
          location: view.location,
          category: 'deadCode',
          fixes: [],
        });
      }
    }
  }

  // ---- XML IDs declared but never referenced ----
  if (CONFIDENCE_RANK['probably_unused'] >= CONFIDENCE_RANK[minConfidence]) {
    const declared = new Map<string, { file: string; location: import('../../semantic/OdooTypes').SourceLocation }>();
    for (const xmlFile of index.xmlFiles.values()) {
      for (const d of xmlFile.declaredIds) {
        declared.set(d.xmlId, { file: d.file ?? xmlFile.file, location: d.location });
      }
    }
    const referenced = new Set<string>();
    for (const xmlFile of index.xmlFiles.values()) {
      for (const u of xmlFile.refUses) {
        referenced.add(u.qualified);
        referenced.add(u.written);
      }
    }
    for (const v of index.viewsById.values()) {
      if (v.inheritId) referenced.add(v.inheritId);
    }
    for (const [xmlId, info] of declared) {
      if (referenced.has(xmlId)) continue;
      // Skip access rights / menu roots often referenced only from other modules outside workspace
      if (xmlId.includes('access_') || xmlId.includes('menu_')) continue;
      diagnostics.push({
        ruleId: 'dead-code-unused-xml-id',
        message: `External ID "${xmlId}" is declared but never referenced by any ref=/inherit_id/action in the indexed workspace. May be used outside this workspace — "probably_unused" confidence.`,
        severity: 'hint',
        confidence: 'low',
        location: info.location,
        category: 'deadCode',
        fixes: [],
      });
    }
  }

  // ---- Cron jobs / server actions with empty code and no obvious binding ----
  if (CONFIDENCE_RANK['unknown'] >= CONFIDENCE_RANK[minConfidence]) {
    for (const cron of index.cronRecords) {
      if (cron.code && cron.code.trim().length > 0) continue;
      if (cron.model) {
        // has a model — likely framework-invoked
        continue;
      }
      diagnostics.push({
        ruleId: 'dead-code-empty-cron',
        message: `Cron "${cron.xmlId ?? cron.name ?? '(unnamed)'}" has no code body and no model binding. Verify it is intentional — "unknown" confidence.`,
        severity: 'hint',
        confidence: 'low',
        location: cron.location,
        category: 'deadCode',
        fixes: [],
      });
    }
    for (const sa of index.serverActionRecords) {
      if (sa.code && sa.code.trim().length > 0) continue;
      if (sa.state && sa.state !== 'code') continue;
      diagnostics.push({
        ruleId: 'dead-code-empty-server-action',
        message: `Server action "${sa.xmlId ?? sa.name ?? '(unnamed)'}" has state=code (or unspecified) but empty code. Verify it is intentional — "unknown" confidence.`,
        severity: 'hint',
        confidence: 'low',
        location: sa.location,
        category: 'deadCode',
        fixes: [],
      });
    }
  }


  // ---- Unused Python imports (module-level only; names never referenced in file text) ----
  if (CONFIDENCE_RANK['probably_unused'] >= CONFIDENCE_RANK[minConfidence]) {
    for (const analysis of index.pythonFiles.values()) {
      let source: string | undefined;
      try {
        // Prefer reading from disk only when we have imports to check
        if (!analysis.imports?.length) continue;
      } catch { continue; }
      // We don't keep raw source on the analysis; approximate "used" by checking whether each
      // imported name appears as an identifier elsewhere in any method/field of this file.
      const usedNames = new Set<string>();
      for (const c of analysis.modelContributions) {
        usedNames.add(c.className);
        for (const f of c.fields) usedNames.add(f.name);
        for (const m of c.methods) {
          usedNames.add(m.name);
          for (const cm of m.calledMethods) usedNames.add(cm);
          for (const cn of m.calleeNames) usedNames.add(cn);
        }
      }
      for (const c of analysis.controllerContributions) {
        usedNames.add(c.className);
        for (const m of c.methods) {
          usedNames.add(m.name);
          for (const cn of m.calleeNames) usedNames.add(cn);
        }
      }
      for (const imp of analysis.imports ?? []) {
        // Skip star imports and odoo framework imports that are conventional
        if (imp.names.includes('*')) continue;
        if (imp.module === 'odoo' || imp.module.startsWith('odoo.')) {
          // Still check individual names from `from odoo import X`
          for (const name of imp.names) {
            if (name === 'models' || name === 'fields' || name === 'api' || name === '_') continue;
            if (usedNames.has(name)) continue;
            // Low confidence: name may appear only in type comments or string forms
            diagnostics.push({
              ruleId: 'dead-code-unused-import',
              message: `Imported name "${name}" from "${imp.module}" is not referenced by any extracted symbol in this file. May still be used in ways the static index does not see — "probably_unused" confidence.`,
              severity: 'hint',
              confidence: 'low',
              location: imp.location,
              category: 'deadCode',
              fixes: [],
            });
          }
          continue;
        }
        if (imp.names.length === 0) {
          // bare `import foo.bar` — treat last segment as binding
          const last = imp.module.split('.').filter(Boolean).pop() ?? imp.module;
          if (usedNames.has(last)) continue;
          diagnostics.push({
            ruleId: 'dead-code-unused-import',
            message: `Import "${imp.module}" does not appear to be referenced in this file — "probably_unused" confidence.`,
            severity: 'hint',
            confidence: 'low',
            location: imp.location,
            category: 'deadCode',
            fixes: [],
          });
        } else {
          for (const name of imp.names) {
            if (usedNames.has(name)) continue;
            diagnostics.push({
              ruleId: 'dead-code-unused-import',
              message: `Imported name "${name}" from "${imp.module}" is not referenced by any extracted symbol in this file — "probably_unused" confidence.`,
              severity: 'hint',
              confidence: 'low',
              location: imp.location,
              category: 'deadCode',
              fixes: [],
            });
          }
        }
      }
    }
  }

  // ---- Unused modules (nothing depends on them; not an application entrypoint) ----
  if (CONFIDENCE_RANK['probably_unused'] >= CONFIDENCE_RANK[minConfidence]) {
    const dependedOn = new Set<string>();
    for (const manifest of index.modules.values()) {
      for (const d of manifest.depends) dependedOn.add(d);
    }
    for (const [modName, manifest] of index.modules) {
      if (manifest.application) continue; // apps are intentional roots
      if (manifest.auto_install) continue;
      if (dependedOn.has(modName)) continue;
      // If the module contributes any model that is referenced, keep it
      let contributesUsedModel = false;
      for (const [modelName, model] of index.models) {
        if (!model.modules.has(modName)) continue;
        const usages = index.references.getModelUsages(modelName);
        if (usages.length > 0) { contributesUsedModel = true; break; }
        if (Array.from(index.viewsById.values()).some((v) => v.model === modelName)) {
          contributesUsedModel = true; break;
        }
      }
      if (contributesUsedModel) continue;
      diagnostics.push({
        ruleId: 'dead-code-unused-module',
        message: `Module "${modName}" is not in any other module's depends list, is not an application, and exposes no obviously referenced models/views. May still be installed explicitly — "probably_unused" confidence.`,
        severity: 'hint',
        confidence: 'low',
        location: manifest.location,
        category: 'deadCode',
        fixes: [],
      });
    }
  }

  // ---- Unused reports (no template reference, model missing or unused) ----
  if (CONFIDENCE_RANK['probably_unused'] >= CONFIDENCE_RANK[minConfidence]) {
    const templateNames = new Set<string>();
    for (const t of index.templateRecords) {
      if (t.tName) templateNames.add(t.tName);
      if (t.xmlId) templateNames.add(t.xmlId);
    }
    // Also treat declared XML ids as possible report targets
    for (const xmlFile of index.xmlFiles.values()) {
      for (const d of xmlFile.declaredIds) templateNames.add(d.xmlId);
    }
    for (const report of index.reportRecords) {
      const templateOk = report.reportName ? templateNames.has(report.reportName) : false;
      const modelOk = report.model ? index.models.has(report.model) : false;
      if (templateOk || modelOk) continue;
      diagnostics.push({
        ruleId: 'dead-code-unused-report',
        message: `Report "${report.xmlId}" has no matching QWeb template${report.reportName ? ` (report_name="${report.reportName}")` : ''} and its model is missing from the index. May be incomplete or unused — "probably_unused" confidence.`,
        severity: 'hint',
        confidence: 'low',
        location: report.location,
        category: 'deadCode',
        fixes: [],
      });
    }
  }

  return diagnostics;
}
