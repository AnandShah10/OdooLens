import { XmlNodeRef, OdooRuleRecord } from '../../semantic/OdooTypes';
import { findDescendants } from './XmlParser';

/**
 * Extracts every `<record model="ir.rule">` (record-rule) in a parsed XML document. Model and
 * group references are resolved the same way `ViewExtractor` resolves `inherit_id`: a bare
 * `ref="foo"` is namespaced to the current module (`module.foo`) unless already dotted.
 */
export function extractRuleRecords(root: XmlNodeRef, module: string, file: string): OdooRuleRecord[] {
  const results: OdooRuleRecord[] = [];
  for (const rec of findDescendants(root, 'record')) {
    if (rec.attributes.model !== 'ir.rule') continue;
    const id = rec.attributes.id;
    if (!id) continue;
    const xmlId = id.includes('.') ? id : `${module}.${id}`;

    let name: string | undefined;
    let model: string | undefined;
    let domainForce: string | undefined;
    const groups: string[] = [];

    for (const field of rec.children) {
      if (field.tag !== 'field') continue;
      const fieldName = field.attributes.name;
      if (fieldName === 'name') name = (field.text ?? '').trim();
      if (fieldName === 'model_id') {
        // model_id is stored as `model_<underscored_model_name>` by Odoo's own external-id
        // convention; strip the `model_` prefix and un-underscore to recover the model name.
        const ref = field.attributes.ref;
        if (ref) {
          const localId = ref.includes('.') ? ref.split('.').pop()! : ref;
          if (localId.startsWith('model_')) model = localId.slice('model_'.length).replace(/_/g, '.');
        }
      }
      if (fieldName === 'domain_force') domainForce = (field.text ?? '').trim();
      if (fieldName === 'groups') {
        // Typically `eval="[(4, ref('base.group_x'))]"` or similar; best-effort: pull ref(...)
        // literal string arguments out of the eval attribute text via a targeted scan.
        const evalAttr = field.attributes.eval ?? '';
        const refMatches = evalAttr.match(/ref\(\s*['"]([\w.]+)['"]\s*\)/g) ?? [];
        for (const m of refMatches) {
          const inner = m.match(/ref\(\s*['"]([\w.]+)['"]\s*\)/);
          if (inner) groups.push(inner[1]);
        }
      }
    }

    results.push({
      xmlId,
      module,
      name,
      model,
      domainForce,
      groups,
      isGlobal: groups.length === 0,
      location: rec.location,
      file,
    });
  }
  return results;
}
