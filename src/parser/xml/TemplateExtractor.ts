import { XmlNodeRef, OdooTemplateRecord, SourceLocation } from '../../semantic/OdooTypes';
import { findDescendants } from './XmlParser';

function walk(node: XmlNodeRef): XmlNodeRef[] {
  const out: XmlNodeRef[] = [node];
  for (const c of node.children) out.push(...walk(c));
  return out;
}

function collectExpressions(root: XmlNodeRef): OdooTemplateRecord['fieldExpressions'] {
  const out: OdooTemplateRecord['fieldExpressions'] = [];
  for (const node of walk(root)) {
    for (const kind of ['t-field', 't-esc', 't-out', 't-raw'] as const) {
      const expr = node.attributes[kind];
      if (expr) out.push({ expr, kind, location: node.location });
    }
  }
  return out;
}

function collectTCalls(root: XmlNodeRef): OdooTemplateRecord['tCalls'] {
  const out: OdooTemplateRecord['tCalls'] = [];
  for (const node of walk(root)) {
    const call = node.attributes['t-call'] || node.attributes['t-call-assets'];
    if (call) out.push({ name: call, location: node.location });
  }
  return out;
}

/**
 * Extracts QWeb templates: <template id="..." t-name="..."> and <record model="ir.ui.view">
 * with type=qweb. Also standalone roots that only define t-name (common in website modules).
 */
export function extractTemplateRecords(root: XmlNodeRef, module: string, file: string): OdooTemplateRecord[] {
  const results: OdooTemplateRecord[] = [];

  for (const node of findDescendants(root, 'template')) {
    const id = node.attributes.id;
    const tName = node.attributes['t-name'];
    const inheritRaw = node.attributes['t-inherit'] || node.attributes['inherit_id'];
    let inheritId: string | undefined;
    if (inheritRaw) {
      // inherit_id may be a ref-like id or a t-name
      inheritId = inheritRaw.includes('.') || !id ? inheritRaw : `${module}.${inheritRaw}`;
    }
    const xmlId = id ? (id.includes('.') ? id : `${module}.${id}`) : undefined;
    results.push({
      xmlId,
      tName,
      module,
      inheritId,
      fieldExpressions: collectExpressions(node),
      tCalls: collectTCalls(node),
      file,
      location: node.location,
      archNode: node,
    });
  }

  // QWeb views stored as ir.ui.view with type/key
  for (const rec of findDescendants(root, 'record')) {
    if (rec.attributes.model !== 'ir.ui.view') continue;
    let viewType: string | undefined;
    let tName: string | undefined;
    let archField: XmlNodeRef | undefined;
    let inheritId: string | undefined;
    for (const field of rec.children) {
      if (field.tag !== 'field') continue;
      const fname = field.attributes.name;
      if (fname === 'type') viewType = (field.text ?? '').trim();
      if (fname === 'key' || fname === 'name') {
        const v = (field.text ?? '').trim();
        if (fname === 'key') tName = v;
      }
      if (fname === 'arch') archField = field;
      if (fname === 'inherit_id' && field.attributes.ref) {
        inheritId = field.attributes.ref.includes('.')
          ? field.attributes.ref
          : `${module}.${field.attributes.ref}`;
      }
    }
    if (viewType !== 'qweb' && !tName) continue;
    const id = rec.attributes.id;
    const xmlId = id ? (id.includes('.') ? id : `${module}.${id}`) : undefined;
    const archRoot = archField?.children[0];
    results.push({
      xmlId,
      tName,
      module,
      inheritId,
      fieldExpressions: archRoot ? collectExpressions(archRoot) : [],
      tCalls: archRoot ? collectTCalls(archRoot) : [],
      file,
      location: rec.location,
      archNode: archRoot,
    });
  }

  return results;
}
