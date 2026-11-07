export interface AccessRuleRow {
  id: string;
  name: string;
  modelId: string; // e.g. model_sale_order (the `model_id:id` column, raw)
  groupId?: string;
  permRead: boolean;
  permWrite: boolean;
  permCreate: boolean;
  permUnlink: boolean;
  line: number; // 0-based
  file: string;
}

/** Parses `ir.model.access.csv` (comma-separated, header row required). No external CSV dependency. */
export function parseAccessCsv(file: string, source: string): AccessRuleRow[] {
  const lines = source.split(/\r?\n/);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]);
  const idx = (name: string) => header.indexOf(name);
  const rows: AccessRuleRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const cols = splitCsvLine(raw);
    if (cols.length < header.length) continue;
    rows.push({
      id: cols[idx('id')] ?? '',
      name: cols[idx('name')] ?? '',
      modelId: cols[idx('model_id:id')] ?? '',
      groupId: cols[idx('group_id:id')] || undefined,
      permRead: cols[idx('perm_read')] === '1',
      permWrite: cols[idx('perm_write')] === '1',
      permCreate: cols[idx('perm_create')] === '1',
      permUnlink: cols[idx('perm_unlink')] === '1',
      line: i,
      file,
    });
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
