import { SourceLocation, XmlNodeRef } from '../../semantic/OdooTypes';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Given a parsed XML node and the raw source lines of the file it came from, locates the exact
 * character span of a specific attribute's VALUE (not the whole attribute, not the whole tag).
 *
 * This exists specifically to make renaming an Odoo field's XML usages safe: `saxes` (like most
 * SAX-style parsers) only reports the *tag's* start/end position, not per-attribute positions,
 * so without this we could only say "the field's `name` attribute is somewhere in this element"
 * — not precise enough to build a text edit. This scans only the handful of lines the element's
 * own opening tag spans (bounded by `node.location`), so it cannot accidentally match an
 * identically-valued attribute belonging to a different, unrelated element elsewhere in the
 * file — the search space is the element itself, not the whole document.
 *
 * Returns null if the attribute/value pair can't be found in that line range (e.g. unusual
 * whitespace/formatting this simple scan doesn't anticipate) — callers must treat that as "do
 * not rename this occurrence" rather than guessing.
 */
export function locateAttributeValue(
  fileLines: string[],
  node: XmlNodeRef,
  attrName: string,
  attrValue: string
): SourceLocation | null {
  if (node.attributes[attrName] !== attrValue) return null;

  const pattern = new RegExp(`${escapeRegExp(attrName)}\\s*=\\s*(['"])${escapeRegExp(attrValue)}\\1`);
  const startLine = Math.max(0, node.location.startLine);
  // Self-closing/leaf tags (the common case for `<field name="x"/>`) have their whole opening
  // tag within `startLine..endLine`; cap the scan window defensively in case of an unusually
  // large element so this stays cheap.
  const endLine = Math.min(fileLines.length - 1, node.location.endLine, startLine + 20);

  for (let line = startLine; line <= endLine; line++) {
    const text = fileLines[line];
    if (text === undefined) continue;
    const match = pattern.exec(text);
    if (!match) continue;
    const quoteChar = match[1];
    const valueStart = match.index + match[0].indexOf(quoteChar) + 1;
    return {
      file: node.location.file,
      startLine: line,
      startCol: valueStart,
      endLine: line,
      endCol: valueStart + attrValue.length,
    };
  }
  return null;
}
