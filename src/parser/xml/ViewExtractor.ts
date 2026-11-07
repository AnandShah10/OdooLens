import { XmlNodeRef, OdooViewRecord } from '../../semantic/OdooTypes';
import { findDescendants } from './XmlParser';

const VIEW_TYPES = ['form', 'tree', 'list', 'kanban', 'search', 'calendar', 'graph', 'pivot', 'activity'];

/** Extracts every `<record model="ir.ui.view">` in a parsed XML document. */
export function extractViewRecords(root: XmlNodeRef, module: string, file: string): OdooViewRecord[] {
  const results: OdooViewRecord[] = [];
  const records = findDescendants(root, 'record');
  for (const rec of records) {
    if (rec.attributes.model !== 'ir.ui.view') continue;
    const id = rec.attributes.id;
    if (!id) continue;
    const xmlId = id.includes('.') ? id : `${module}.${id}`;

    let model: string | undefined;
    let inheritId: string | undefined;
    let archField: XmlNodeRef | undefined;

    for (const field of rec.children) {
      if (field.tag !== 'field') continue;
      const name = field.attributes.name;
      if (name === 'model') model = (field.text ?? '').trim();
      if (name === 'inherit_id') {
        const ref = field.attributes.ref;
        if (ref) inheritId = ref.includes('.') ? ref : `${module}.${ref}`;
      }
      if (name === 'arch') archField = field;
    }

    let archRoot: XmlNodeRef | undefined;
    let viewType: string | undefined;
    if (archField) {
      // <field name="arch" type="xml"> wraps the actual view root as its single element child.
      archRoot = archField.children[0];
      if (archRoot) {
        viewType = VIEW_TYPES.includes(archRoot.tag) ? archRoot.tag : archRoot.tag === 'xpath' ? 'inherited' : archRoot.tag;
      }
    }

    results.push({
      xmlId,
      module,
      model,
      inheritId,
      viewType,
      archNode: archRoot,
      location: rec.location,
      file,
    });
  }
  return results;
}
