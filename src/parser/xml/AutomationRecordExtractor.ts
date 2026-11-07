import { XmlNodeRef, OdooCronRecord, OdooServerActionRecord } from '../../semantic/OdooTypes';
import { findDescendants } from './XmlParser';

function resolveModelRef(field: XmlNodeRef): string | undefined {
  const ref = field.attributes.ref;
  if (!ref) return undefined;
  const localId = ref.includes('.') ? ref.split('.').pop()! : ref;
  return localId.startsWith('model_') ? localId.slice('model_'.length).replace(/_/g, '.') : undefined;
}

/** Extracts every `<record model="ir.cron">` (scheduled action) in a parsed XML document. */
export function extractCronRecords(root: XmlNodeRef, module: string, file: string): OdooCronRecord[] {
  const results: OdooCronRecord[] = [];
  for (const rec of findDescendants(root, 'record')) {
    if (rec.attributes.model !== 'ir.cron') continue;
    const id = rec.attributes.id;
    if (!id) continue;
    const xmlId = id.includes('.') ? id : `${module}.${id}`;

    let name: string | undefined;
    let model: string | undefined;
    let code: string | undefined;
    let active = true;

    for (const field of rec.children) {
      if (field.tag !== 'field') continue;
      const fieldName = field.attributes.name;
      if (fieldName === 'name') name = (field.text ?? '').trim();
      if (fieldName === 'model_id') model = resolveModelRef(field);
      if (fieldName === 'code') code = field.text;
      if (fieldName === 'active') active = (field.text ?? '').trim().toLowerCase() !== 'false' && field.attributes.eval !== 'False';
    }

    results.push({ xmlId, module, name, model, code, active, location: rec.location, file });
  }
  return results;
}

/** Extracts every `<record model="ir.actions.server">` (server action) in a parsed XML document. */
export function extractServerActionRecords(root: XmlNodeRef, module: string, file: string): OdooServerActionRecord[] {
  const results: OdooServerActionRecord[] = [];
  for (const rec of findDescendants(root, 'record')) {
    if (rec.attributes.model !== 'ir.actions.server') continue;
    const id = rec.attributes.id;
    if (!id) continue;
    const xmlId = id.includes('.') ? id : `${module}.${id}`;

    let name: string | undefined;
    let model: string | undefined;
    let state: string | undefined;
    let code: string | undefined;

    for (const field of rec.children) {
      if (field.tag !== 'field') continue;
      const fieldName = field.attributes.name;
      if (fieldName === 'name') name = (field.text ?? '').trim();
      if (fieldName === 'model_id') model = resolveModelRef(field);
      if (fieldName === 'state') state = (field.text ?? '').trim();
      if (fieldName === 'code') code = field.text;
    }

    results.push({ xmlId, module, name, model, state, code, location: rec.location, file });
  }
  return results;
}
