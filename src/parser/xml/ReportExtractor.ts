import { XmlNodeRef, OdooReportRecord } from '../../semantic/OdooTypes';
import { findDescendants } from './XmlParser';

/**
 * Extracts ir.actions.report records (both <record model="ir.actions.report"> and
 * the short-form <report .../> tag used in older modules).
 */
export function extractReportRecords(root: XmlNodeRef, module: string, file: string): OdooReportRecord[] {
  const results: OdooReportRecord[] = [];

  // Short-form <report id="..." model="..." name="..." report_type="qweb-pdf"/>
  for (const node of findDescendants(root, 'report')) {
    const id = node.attributes.id;
    if (!id) continue;
    const xmlId = id.includes('.') ? id : `${module}.${id}`;
    results.push({
      xmlId,
      module,
      name: node.attributes.string ?? node.attributes.name,
      model: node.attributes.model,
      reportType: node.attributes.report_type ?? node.attributes.type,
      reportName: node.attributes.name, // template t-name
      file,
      location: node.location,
    });
  }

  // Full <record model="ir.actions.report">
  for (const rec of findDescendants(root, 'record')) {
    if (rec.attributes.model !== 'ir.actions.report') continue;
    const id = rec.attributes.id;
    if (!id) continue;
    const xmlId = id.includes('.') ? id : `${module}.${id}`;
    let name: string | undefined;
    let model: string | undefined;
    let reportType: string | undefined;
    let reportName: string | undefined;
    for (const field of rec.children) {
      if (field.tag !== 'field') continue;
      const fname = field.attributes.name;
      const val = (field.text ?? '').trim() || field.attributes.eval;
      if (fname === 'name') name = val;
      if (fname === 'model') model = val;
      if (fname === 'report_type') reportType = val;
      if (fname === 'report_name') reportName = val;
    }
    results.push({ xmlId, module, name, model, reportType, reportName, file, location: rec.location });
  }

  return results;
}
