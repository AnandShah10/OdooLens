import { OdooDiagnostic } from '../../semantic/OdooTypes';
import { OdooWorkspaceIndex } from '../../index/OdooIndex';

/**
 * Deeper QWeb / template analysis:
 * - unresolved t-call targets
 * - t-field / t-esc expressions that look like simple field paths on a known report model
 * - template inherit targets that cannot be resolved
 *
 * Conservative: QWeb expressions can be arbitrary Python; we only flag simple
 * identifier / dotted paths and only when we have a model context from a report binding.
 */
export function analyzeQwebTemplates(index: OdooWorkspaceIndex): OdooDiagnostic[] {
  const diagnostics: OdooDiagnostic[] = [];

  // Index all known template names / ids for t-call resolution
  const knownTemplates = new Set<string>();
  for (const t of index.templateRecords) {
    if (t.tName) knownTemplates.add(t.tName);
    if (t.xmlId) knownTemplates.add(t.xmlId);
  }
  // report_name values also act as template keys
  for (const r of index.reportRecords) {
    if (r.reportName) knownTemplates.add(r.reportName);
  }

  // Map report_name / model for field checks
  const reportModelByTemplate = new Map<string, string>();
  for (const r of index.reportRecords) {
    if (r.reportName && r.model) reportModelByTemplate.set(r.reportName, r.model);
  }

  for (const tmpl of index.templateRecords) {
    // Unresolved inherit
    if (tmpl.inheritId) {
      const ok =
        knownTemplates.has(tmpl.inheritId) ||
        index.viewsById.has(tmpl.inheritId) ||
        Array.from(index.xmlFiles.values()).some((f) =>
          f.declaredIds.some((d) => d.xmlId === tmpl.inheritId || d.xmlId.endsWith('.' + tmpl.inheritId))
        );
      if (!ok) {
        diagnostics.push({
          ruleId: 'qweb-unresolved-inherit',
          message: `QWeb template ${tmpl.tName ?? tmpl.xmlId ?? '(anonymous)'} inherits "${tmpl.inheritId}", which was not found in the indexed workspace.`,
          severity: 'warning',
          confidence: 'medium',
          location: tmpl.location,
          category: 'xml',
          fixes: [],
        });
      }
    }

    // Unresolved t-call
    for (const call of tmpl.tCalls) {
      // Asset bundles and website.* helpers are often outside the workspace
      if (call.name.startsWith('web.') || call.name.startsWith('website.') || call.name.startsWith('portal.')) {
        continue;
      }
      if (knownTemplates.has(call.name)) continue;
      // Prefix match for module-qualified calls
      const found = Array.from(knownTemplates).some(
        (k) => k === call.name || k.endsWith('.' + call.name) || call.name.endsWith('.' + k)
      );
      if (found) continue;
      diagnostics.push({
        ruleId: 'qweb-unresolved-t-call',
        message: `t-call="${call.name}" does not match any indexed QWeb template or report_name in the workspace. If the template lives in another addons path, add it via odooIntelligence.addonsPaths.`,
        severity: 'warning',
        confidence: 'low',
        location: call.location,
        category: 'xml',
        fixes: [],
      });
    }

    // Simple t-field path validation when we know the report model
    const modelName =
      (tmpl.tName && reportModelByTemplate.get(tmpl.tName)) ||
      (tmpl.xmlId && reportModelByTemplate.get(tmpl.xmlId));
    if (!modelName) continue;
    const model = index.getModel(modelName);
    if (!model) continue;

    for (const fe of tmpl.fieldExpressions) {
      if (fe.kind !== 't-field') continue; // t-esc/t-out are arbitrary expressions
      const path = fe.expr.trim();
      // Only simple field or doc.field / o.field style
      const simple = path.match(/^(?:doc|o|object|record)\.([A-Za-z_][A-Za-z0-9_]*)$/) || path.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
      if (!simple) continue;
      const fieldName = simple[1];
      if (model.fields.has(fieldName)) continue;
      // Always-present framework fields
      if (['id', 'display_name', 'name', 'create_date', 'write_date'].includes(fieldName)) continue;
      diagnostics.push({
        ruleId: 'qweb-unknown-t-field',
        message: `t-field="${fe.expr}" refers to field "${fieldName}" which was not found on model "${modelName}" (bound via report). If the field is added dynamically, this may be a false positive.`,
        severity: 'warning',
        confidence: 'medium',
        location: fe.location,
        category: 'xml',
        fixes: [],
      });
    }
  }

  return diagnostics;
}
