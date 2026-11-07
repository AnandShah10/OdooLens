import { OdooDiagnostic, OdooViewRecord } from '../../semantic/OdooTypes';
import { OdooWorkspaceIndex, XmlFileAnalysis } from '../../index/OdooIndex';
import { findDescendants } from '../../parser/xml/XmlParser';
import { mergeViewChain } from '../../parser/xml/ViewMerger';
import { DeclaredXmlId } from '../../parser/xml/XmlIdExtractor';
import { detectMajorVersion, OdooVersion } from '../../versioning/MigrationRules';

const ALWAYS_PRESENT_FIELDS = new Set(['id', 'display_name', 'create_date', 'write_date', 'create_uid', 'write_uid', '__last_update']);

/** Orders the views that (transitively) inherit `baseId`, shallowest first, for chained merging. */
function computeInheritanceChain(index: OdooWorkspaceIndex, baseId: string): OdooViewRecord[] {
  const children = (id: string) =>
    Array.from(index.viewsById.values())
      .filter((v) => v.inheritId === id)
      .sort((a, b) => index.moduleOrder.indexOf(a.module) - index.moduleOrder.indexOf(b.module));

  const chain: OdooViewRecord[] = [];
  let frontier = children(baseId);
  const seen = new Set<string>([baseId]);
  while (frontier.length > 0) {
    const next: OdooViewRecord[] = [];
    for (const v of frontier) {
      if (seen.has(v.xmlId)) continue; // cycle guard
      seen.add(v.xmlId);
      chain.push(v);
      next.push(...children(v.xmlId));
    }
    frontier = next;
  }
  return chain;
}

export function analyzeXmlFile(index: OdooWorkspaceIndex, xmlFile: XmlFileAnalysis): OdooDiagnostic[] {
  const diagnostics: OdooDiagnostic[] = [];

  // --- Unresolved model= references on <record> / <template> etc. ---
  // Only flag models that look like Odoo model names (contain a dot) and are absent from the
  // index. Core/framework models that live outside the workspace are intentionally skipped
  // (same false-positive guard used by the unresolved-ref rule).
  if (xmlFile.root) {
    for (const rec of findDescendants(xmlFile.root, 'record')) {
      const modelAttr = rec.attributes.model;
      if (!modelAttr || !modelAttr.includes('.')) continue;
      // Skip well-known meta models that are always present in a real Odoo registry.
      if (modelAttr.startsWith('ir.') || modelAttr.startsWith('res.') || modelAttr === 'base') continue;
      if (!index.models.has(modelAttr)) {
        diagnostics.push({
          ruleId: 'xml-unresolved-model',
          message: `Record references model="${modelAttr}" which was not found in the indexed workspace. If the model is defined in a module outside this workspace (or by the Odoo core), this is expected; otherwise the model name may be misspelled.`,
          severity: 'warning',
          confidence: 'low',
          location: rec.location,
          category: 'xml',
          fixes: [],
        });
      }
    }
  }

  for (const view of xmlFile.views) {
    // --- Field-existence validation (only for base views we can resolve a model for) ---
    if (view.model && view.archNode && !view.inheritId) {
      const model = index.getModel(view.model);
      if (model) {
        for (const fieldNode of findDescendants(view.archNode, 'field')) {
          const name = fieldNode.attributes.name;
          if (!name || name.includes('.') || ALWAYS_PRESENT_FIELDS.has(name)) continue;
          if (!model.fields.has(name)) {
            diagnostics.push({
              ruleId: 'xml-field-not-found',
              message: `Field "${name}" does not exist on model "${view.model}" (as resolved by the static index). If this field is added dynamically or by a module outside the current workspace, this may be a false positive.`,
              severity: 'error',
              confidence: 'high',
              location: fieldNode.location,
              category: 'xml',
              fixes: [],
            });
          }
        }
        for (const buttonNode of findDescendants(view.archNode, 'button')) {
          const name = buttonNode.attributes.name;
          const type = buttonNode.attributes.type;
          if (type === 'object' && name && !model.methods.has(name)) {
            diagnostics.push({
              ruleId: 'xml-button-method-not-found',
              message: `Button references method "${name}" which was not found on model "${view.model}". Verify the method exists (it may be defined dynamically or in a module outside this workspace).`,
              severity: 'warning',
              confidence: 'medium',
              location: buttonNode.location,
              category: 'xml',
              fixes: [],
            });
          }
        }
      } else if (view.model.includes('.')) {
        // View declares a model that the index does not know — surface once per view.
        diagnostics.push({
          ruleId: 'xml-unresolved-model',
          message: `View "${view.xmlId}" is bound to model="${view.model}" which was not found in the indexed workspace.`,
          severity: 'warning',
          confidence: 'low',
          location: view.location,
          category: 'xml',
          fixes: [],
        });
      }
    }

    // --- XPath inheritance validation ---
    if (view.inheritId) {
      const base = index.viewsById.get(view.inheritId);
      if (!base) {
        diagnostics.push({
          ruleId: 'xml-missing-inherit-target',
          message: `View "${view.xmlId}" inherits "${view.inheritId}", which was not found anywhere in the indexed workspace.`,
          severity: 'warning',
          confidence: 'low',
          location: view.location,
          category: 'xml',
          fixes: [],
        });
      }
    }
  }

  // --- Base-view xpath resolution: only run once per base view, from the file that defines it ---
  for (const view of xmlFile.views) {
    if (view.inheritId || !view.archNode) continue;
    const chain = computeInheritanceChain(index, view.xmlId);
    if (chain.length === 0) continue;
    const { issues } = mergeViewChain(view, chain);
    for (const issue of issues) {
      diagnostics.push({
        ruleId: 'xml-xpath-target-not-found',
        message: `${issue.message} (patch defined in module "${issue.view.module}", view "${issue.view.xmlId}")`,
        severity: 'warning',
        confidence: 'medium',
        location: issue.view.archNode?.location ?? issue.view.location,
        category: 'xml',
        fixes: [],
      });
    }
  }


  // --- Version-aware attribute / tag checks (static approximation of framework changes) ---
  const manifestVersions = Array.from(index.modules.values()).map((m) => m.version);
  const major = detectMajorVersion(manifestVersions);
  if (major) {
    const majorNum = parseInt(major, 10);
    for (const view of xmlFile.views) {
      if (!view.archNode) continue;
      // attrs= / states= deprecated as of Odoo 17 view arch
      if (majorNum >= 17) {
        for (const node of walkXml(view.archNode)) {
          if (node.attributes.attrs !== undefined) {
            diagnostics.push({
              ruleId: 'xml-deprecated-attrs-attribute',
              message: `View attribute attrs="..." is deprecated since Odoo 17 (workspace detected as ${major}). Prefer invisible=/readonly=/required= with Python expressions.`,
              severity: 'warning',
              confidence: 'high',
              location: node.location,
              category: 'xml',
              fixes: [],
            });
          }
          if (node.attributes.states !== undefined) {
            diagnostics.push({
              ruleId: 'xml-deprecated-states-attribute',
              message: `View attribute states="..." is deprecated since Odoo 17 (workspace detected as ${major}). Prefer invisible="state not in (...)" expressions.`,
              severity: 'warning',
              confidence: 'high',
              location: node.location,
              category: 'xml',
              fixes: [],
            });
          }
        }
      }
      // <tree> root deprecated in favour of <list> from Odoo 18
      if (majorNum >= 18 && view.archNode.tag === 'tree' && !view.inheritId) {
        diagnostics.push({
          ruleId: 'xml-deprecated-tree-tag',
          message: `Root view tag <tree> is invalid on Odoo 18+ (workspace detected as ${major}); use <list> instead.`,
          severity: 'error',
          confidence: 'high',
          location: view.archNode.location,
          category: 'xml',
          fixes: [],
        });
      }
    }
  }

  // Duplicate-XML-id detection is workspace-wide and handled separately by findDuplicateXmlIds(),
  // since it requires seeing every file, not just this one.

  return diagnostics;
}

/**
 * Workspace-wide duplicate external-id detection. Iterates every file's declared ids (not
 * `viewsById`: that is a Map keyed by the very id being checked, so it can never contain a
 * duplicate — an earlier version of this function iterated it and so never fired). Same-id
 * redeclaration within one module is technically legal in Odoo (the later declaration updates
 * the earlier one) but is overwhelmingly an accident (copy-paste), hence `medium` confidence.
 */
export function findDuplicateXmlIds(index: OdooWorkspaceIndex): OdooDiagnostic[] {
  const diagnostics: OdooDiagnostic[] = [];
  const byId = new Map<string, DeclaredXmlId[]>();
  for (const xmlFile of index.xmlFiles.values()) {
    for (const decl of xmlFile.declaredIds) {
      const arr = byId.get(decl.xmlId) ?? [];
      arr.push(decl);
      byId.set(decl.xmlId, arr);
    }
  }
  for (const [id, decls] of byId) {
    if (decls.length <= 1) continue;
    for (const d of decls) {
      const others = decls.filter((o) => o !== d).map((o) => `${o.file}:${o.location.startLine + 1}`);
      diagnostics.push({
        ruleId: 'xml-duplicate-id',
        message: `External ID "${id}" is declared ${decls.length} times (also at ${others.join(', ')}). Odoo applies the later declaration over the earlier one, which is usually an accidental copy-paste rather than a deliberate override.`,
        severity: 'warning',
        confidence: 'medium',
        location: d.location,
        category: 'xml',
        fixes: [],
      });
    }
  }
  return diagnostics;
}

// Ids Odoo's ORM generates itself (model/field/constraint/index records) are never declared in
// any XML file, so a reference to one is always fine and must never be flagged.
const AUTO_GENERATED_ID_PREFIXES = ['model_', 'field_', 'constraint_', 'index_'];

/**
 * Flags references (`ref=`, `eval="ref(...)"`, menuitem action/parent/groups, button
 * `type="action"`) to an external id in a WORKSPACE module that no XML file or access-CSV row
 * declares. Scoped to workspace modules on purpose: a ref into a module we haven't indexed
 * (e.g. `base.group_user`) can't be judged, so it's skipped rather than guessed at. Medium
 * confidence because an id can legitimately be created somewhere static analysis can't see
 * (a `post_init_hook`, data created by Python code).
 */
export function findUnresolvedXmlRefs(index: OdooWorkspaceIndex): OdooDiagnostic[] {
  const declared = new Set<string>();
  for (const xmlFile of index.xmlFiles.values()) {
    for (const d of xmlFile.declaredIds) declared.add(d.xmlId);
  }
  // Access-CSV rows also declare external ids (`access_x` -> `module.access_x`).
  for (const row of index.accessRules) {
    const mod = index.moduleOf(row.file);
    if (mod && row.id) declared.add(`${mod}.${row.id}`);
  }

  const diagnostics: OdooDiagnostic[] = [];
  for (const xmlFile of index.xmlFiles.values()) {
    for (const use of xmlFile.refUses) {
      const dot = use.qualified.indexOf('.');
      const targetModule = use.qualified.slice(0, dot);
      const localId = use.qualified.slice(dot + 1);
      if (!index.modules.has(targetModule)) continue; // outside the workspace: can't judge
      if (AUTO_GENERATED_ID_PREFIXES.some((p) => localId.startsWith(p))) continue;
      if (declared.has(use.qualified)) continue;
      diagnostics.push({
        ruleId: 'xml-unresolved-ref',
        message: `Reference to "${use.written}" (${use.kind}) points at module "${targetModule}", which is in this workspace, but no XML file or access-CSV row declares the id "${localId}". Check for a typo, or that the declaring data file is listed in the manifest. (If it is created at runtime by Python code, this is a false positive.)`,
        severity: 'warning',
        confidence: 'medium',
        location: use.location,
        category: 'xml',
        fixes: [],
      });
    }
  }
  return diagnostics;
}

function walkXml(node: import('../../semantic/OdooTypes').XmlNodeRef): import('../../semantic/OdooTypes').XmlNodeRef[] {
  const out: import('../../semantic/OdooTypes').XmlNodeRef[] = [node];
  for (const c of node.children) out.push(...walkXml(c));
  return out;
}
