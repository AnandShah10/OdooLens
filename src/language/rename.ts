import * as vscode from 'vscode';
import * as fs from 'fs';
import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { resolveModelContext } from './ModelContextResolver';
import { toRange } from '../utils/VscodeConvert';
import { findDescendants } from '../parser/xml/XmlParser';
import { locateAttributeValue } from '../parser/xml/AttributeLocator';

const MODEL_NAME_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)+$/;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A quoted-string range on one line whose CONTENTS exactly match a known model name. */
function findModelStringRangeAt(
  document: vscode.TextDocument,
  position: vscode.Position,
  index: OdooWorkspaceIndex
): { range: vscode.Range; model: string } | null {
  const line = document.lineAt(position.line).text;
  const re = /(['"])([\w.]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const contentStart = m.index + 1;
    const contentEnd = contentStart + m[2].length;
    if (position.character < contentStart || position.character > contentEnd) continue;
    if (!index.models.has(m[2])) continue;
    return {
      range: new vscode.Range(position.line, contentStart, position.line, contentEnd),
      model: m[2],
    };
  }
  return null;
}

function getLines(cache: Map<string, string[]>, file: string): string[] {
  let lines = cache.get(file);
  if (!lines) {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    cache.set(file, lines);
  }
  return lines;
}

/**
 * Renames three kinds of Odoo symbol, each scoped to exactly how confident OdooLens can be
 * about the edit's safety — see the per-kind rename functions below for the full reasoning.
 * `prepareRename` tries, in order: a model-name string literal under the cursor (a quoted
 * string whose contents exactly match a known model), then a field, then a method — the first
 * one that resolves wins, and `provideRenameEdits` repeats the same dispatch.
 *
 * Field rename now also covers high-confidence Python attribute accesses (the extractor
 * records the exact identifier location of each segment). Domain-tuple / @api.depends string
 * paths and low-confidence heuristic resolutions are still reported as remaining work for the
 * user. Method rename still omits `self.method()` call sites (no precise location is tracked).
 * Model rename additionally covers XML model= / <field name="model"> and conventional
 * ir.model.access.csv model_id:id cells.
 */
export class OdooRenameProvider implements vscode.RenameProvider {
  constructor(private index: OdooWorkspaceIndex) {}

  prepareRename(document: vscode.TextDocument, position: vscode.Position): vscode.Range | { range: vscode.Range; placeholder: string } {
    const modelHit = findModelStringRangeAt(document, position, this.index);
    if (modelHit) return { range: modelHit.range, placeholder: modelHit.model };

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) throw new Error('OdooLens: no renameable symbol under the cursor.');
    const word = document.getText(wordRange);
    const ctx = resolveModelContext(this.index, document, wordRange.start);
    if (!ctx) throw new Error('OdooLens: could not resolve which Odoo model this symbol belongs to.');
    const model = this.index.getModel(ctx.model);
    if (!model) throw new Error(`OdooLens: model "${ctx.model}" was not found in the index.`);
    if (!model.fields.has(word) && !model.methods.has(word)) {
      throw new Error(`OdooLens: "${word}" is not a recognized field or method on ${ctx.model}, so a safe rename cannot be offered.`);
    }
    return { range: wordRange, placeholder: word };
  }

  provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string): vscode.WorkspaceEdit {
    const modelHit = findModelStringRangeAt(document, position, this.index);
    if (modelHit) return this.renameModel(modelHit.model, newName);

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) throw new Error('OdooLens: no renameable symbol under the cursor.');
    const oldName = document.getText(wordRange);
    const ctx = resolveModelContext(this.index, document, wordRange.start);
    if (!ctx) throw new Error('OdooLens: could not resolve which Odoo model this symbol belongs to.');
    const model = this.index.getModel(ctx.model);
    if (!model) throw new Error(`OdooLens: model "${ctx.model}" was not found in the index.`);

    // Fresh per-call cache: file contents must never be reused across separate rename
    // invocations, since the user could have edited a file between two renames in one session.
    const lineCache = new Map<string, string[]>();
    if (model.fields.has(oldName)) return this.renameField(ctx.model, oldName, newName, lineCache);
    if (model.methods.has(oldName)) return this.renameMethod(ctx.model, oldName, newName, lineCache);
    throw new Error(`OdooLens: "${oldName}" is not a recognized field or method on ${ctx.model}.`);
  }

  /**
   * Field rename: (1) every declaration site (`fieldHistory`, exact AST identifier locations),
   * always renamed; (2) XML `<field name="...">` usages on views whose `model` matches, renamed
   * only when `locateAttributeValue()` can pinpoint the exact value span (never touches a
   * `<button name="...">`, never touches `domain="[...]"` strings); (3) high-confidence Python
   * attribute-access usages (`record.field_name`) whose location now points at the exact
   * identifier (upgraded in the extractor). Low-confidence or domain-string usages are still
   * reported as remaining so the user can finish them manually.
   */
  private renameField(modelName: string, oldName: string, newName: string, lineCache: Map<string, string[]>): vscode.WorkspaceEdit {
    if (!IDENTIFIER_RE.test(newName)) throw new Error('OdooLens: field names must be a valid Python identifier.');
    const model = this.index.getModel(modelName)!;
    const history = model.fieldHistory.get(oldName) ?? [];
    if (history.length === 0) throw new Error(`OdooLens: "${oldName}" is not a recognized field on ${modelName}.`);

    const edit = new vscode.WorkspaceEdit();
    for (const decl of history) {
      edit.replace(vscode.Uri.file(decl.location.file), toRange(decl.nameLocation), newName);
    }

    let xmlRenamedCount = 0;
    for (const view of this.index.viewsById.values()) {
      if (view.model !== modelName || !view.archNode) continue;
      for (const fieldNode of findDescendants(view.archNode, 'field')) {
        if (fieldNode.attributes.name !== oldName) continue;
        const valueLoc = locateAttributeValue(getLines(lineCache, view.file), fieldNode, 'name', oldName);
        if (!valueLoc) continue;
        edit.replace(vscode.Uri.file(valueLoc.file), toRange(valueLoc), newName);
        xmlRenamedCount++;
      }
    }

    // High-confidence Python attribute accesses + exact single-segment @api.depends/related paths.
    // Attribute locations point at the identifier; domain locations point at the string contents.
    // Multi-segment paths (e.g. 'partner_id.name') are left alone — rewriting only a leaf would
    // require slicing inside the string, which is easy to get wrong for dotted paths.
    let pyRenamedCount = 0;
    const totalUsages = this.index.references.getFieldUsages(modelName, oldName);
    for (const usage of totalUsages) {
      if (!usage.location) continue;
      if (usage.kind === 'python-attribute') {
        if (usage.confidence === 'low' || usage.confidence === 'medium') continue;
        edit.replace(vscode.Uri.file(usage.location.file), toRange(usage.location), newName);
        pyRenamedCount++;
      } else if (usage.kind === 'python-domain') {
        // Only rewrite when the recorded span is exactly the field name (single-segment path).
        const lines = getLines(lineCache, usage.location.file);
        const line = lines[usage.location.startLine] ?? '';
        const span = line.slice(usage.location.startCol, usage.location.endCol);
        if (span === oldName) {
          edit.replace(vscode.Uri.file(usage.location.file), toRange(usage.location), newName);
          pyRenamedCount++;
        }
      }
    }

    const xmlUsageCount = totalUsages.filter((u) => u.kind === 'xml-field').length;
    const pyUsageCount = totalUsages.filter((u) => u.kind === 'python-attribute' || u.kind === 'python-domain').length;
    const remainingCount = totalUsages.length - Math.min(xmlRenamedCount, xmlUsageCount) - Math.min(pyRenamedCount, pyUsageCount);
    this.notifyResult('field', history.length, xmlRenamedCount + pyRenamedCount, remainingCount, oldName, newName, modelName);
    return edit;
  }

  /**
   * Method rename: every declaration site (`methodHistory`, exact AST identifier locations) and
   * every `<button name="..." type="object">` on a view whose `model` matches (a method name,
   * not a field — `locateAttributeValue()` still does the precise pinpointing). Does NOT rename
   * `self.method_name(...)` Python call sites: OdooLens tracks that a call happened
   * (`calledMethods`) but not its exact source location, so there is nothing precise to edit.
   */
  private renameMethod(modelName: string, oldName: string, newName: string, lineCache: Map<string, string[]>): vscode.WorkspaceEdit {
    if (!IDENTIFIER_RE.test(newName)) throw new Error('OdooLens: method names must be a valid Python identifier.');
    const model = this.index.getModel(modelName)!;
    const history = model.methodHistory.get(oldName) ?? [];
    if (history.length === 0) throw new Error(`OdooLens: "${oldName}" is not a recognized method on ${modelName}.`);

    const edit = new vscode.WorkspaceEdit();
    for (const decl of history) {
      edit.replace(vscode.Uri.file(decl.location.file), toRange(decl.nameLocation), newName);
    }

    let xmlRenamedCount = 0;
    for (const view of this.index.viewsById.values()) {
      if (view.model !== modelName || !view.archNode) continue;
      for (const buttonNode of findDescendants(view.archNode, 'button')) {
        if (buttonNode.attributes.type !== 'object' || buttonNode.attributes.name !== oldName) continue;
        const valueLoc = locateAttributeValue(getLines(lineCache, view.file), buttonNode, 'name', oldName);
        if (!valueLoc) continue;
        edit.replace(vscode.Uri.file(valueLoc.file), toRange(valueLoc), newName);
        xmlRenamedCount++;
      }
    }

    // Python self.method() call sites with exact name locations
    let pyCallRenamedCount = 0;
    for (const [, m] of model.methods) {
      for (const site of m.calledMethodSites ?? []) {
        if (site.name !== oldName) continue;
        edit.replace(vscode.Uri.file(site.location.file), toRange(site.location), newName);
        pyCallRenamedCount++;
      }
    }

    vscode.window.showWarningMessage(
      `OdooLens renamed ${history.length} declaration site(s)` +
        `${xmlRenamedCount ? `, ${xmlRenamedCount} XML <button> reference(s)` : ''}` +
        `${pyCallRenamedCount ? `, ${pyCallRenamedCount} Python call site(s)` : ''} ` +
        `of "${oldName}" → "${newName}" on ${modelName}.`
    );
    return edit;
  }

  /**
   * Model rename: the `_name`/`_inherit` string-literal CONTENTS wherever this model is declared
   * or re-opened (exact AST locations, tracked per-contribution during extraction), plus every
   * `self.env['old.model']` string (also an exact AST location, via `EnvAccessSite.keyLocation`),
   * plus XML view `model=` attributes / `<field name="model">` values that exactly match, plus
   * matching `ir.model.access.csv` `model_id:id` and conventional external-id rows. Still does
   * NOT touch free-form strings, menu actions, or other cross-references whose safety cannot be
   * guaranteed; those remain a manual follow-up (the warning message lists what was left).
   */
  private renameModel(oldName: string, newName: string): vscode.WorkspaceEdit {
    if (!MODEL_NAME_RE.test(newName)) {
      throw new Error('OdooLens: model names must look like "some.model" (lowercase, dot-separated).');
    }
    if (!this.index.models.has(oldName)) throw new Error(`OdooLens: "${oldName}" is not a recognized model.`);

    const edit = new vscode.WorkspaceEdit();
    let declCount = 0;
    let envCount = 0;
    let xmlCount = 0;
    let csvCount = 0;
    const lineCache = new Map<string, string[]>();

    for (const analysis of this.index.pythonFiles.values()) {
      for (const contribution of analysis.modelContributions) {
        if (contribution.name === oldName && contribution.nameLocation) {
          edit.replace(vscode.Uri.file(analysis.file), toRange(contribution.nameLocation), newName);
          declCount++;
        }
        contribution.inherit.forEach((inh, i) => {
          if (inh === oldName && contribution.inheritLocations[i]) {
            edit.replace(vscode.Uri.file(analysis.file), toRange(contribution.inheritLocations[i]), newName);
            declCount++;
          }
        });
        for (const method of contribution.methods) {
          for (const access of method.envAccesses) {
            if (access.model === oldName) {
              edit.replace(vscode.Uri.file(analysis.file), toRange(access.keyLocation), newName);
              envCount++;
            }
          }
        }
      }
    }

    // XML: for every indexed view whose model matches, locate the exact text of
    // <field name="model">oldName</field> (or model="oldName" attribute) inside its file and
    // replace only that span. Never a blind workspace-wide text replace.
    for (const view of this.index.viewsById.values()) {
      if (view.model !== oldName) continue;
      const lines = getLines(lineCache, view.file);
      // Prefer the common <field name="model">VALUE</field> form used by ir.ui.view records.
      const fieldRe = new RegExp(`(<field\\s+name=["']model["'][^>]*>)\\s*${escapeRegExp(oldName)}\\s*(</field>)`, 'i');
      for (let i = 0; i < lines.length; i++) {
        const m = fieldRe.exec(lines[i]);
        if (m) {
          const startCol = m.index + m[1].length;
          const endCol = startCol + oldName.length;
          // Allow surrounding whitespace that the regex consumed.
          const trimmedStart = lines[i].indexOf(oldName, m.index);
          if (trimmedStart >= 0) {
            edit.replace(vscode.Uri.file(view.file), new vscode.Range(i, trimmedStart, i, trimmedStart + oldName.length), newName);
            xmlCount++;
            break; // one model field per view record is enough
          }
        }
      }
      // Also handle model="..." attribute form (less common for views, common for other records).
      const attrRe = new RegExp(`\\bmodel\\s*=\\s*(['"])${escapeRegExp(oldName)}\\1`);
      for (let i = 0; i < lines.length; i++) {
        const m = attrRe.exec(lines[i]);
        if (m) {
          const startCol = m.index + m[0].indexOf(oldName);
          edit.replace(vscode.Uri.file(view.file), new vscode.Range(i, startCol, i, startCol + oldName.length), newName);
          xmlCount++;
          break;
        }
      }
    }

    // CSV: ir.model.access.csv rows whose model_id:id matches the conventional "model_<name_with_underscores>".
    const oldCsvId = 'model_' + oldName.replace(/\./g, '_');
    const newCsvId = 'model_' + newName.replace(/\./g, '_');
    for (const row of this.index.accessRules) {
      if (row.modelId === oldCsvId) {
        const lines = getLines(lineCache, row.file);
        const lineText = lines[row.line] ?? '';
        // Replace the model_id:id cell value on that line. We locate the exact occurrence of the old id.
        const colStart = lineText.indexOf(oldCsvId);
        if (colStart >= 0) {
          const range = new vscode.Range(row.line, colStart, row.line, colStart + oldCsvId.length);
          edit.replace(vscode.Uri.file(row.file), range, newCsvId);
          csvCount++;
        }
        // Also update the row's own external id when it follows the common "access_<model>_*" pattern
        // or is exactly the model id; only exact matches.
        if (row.id === oldCsvId || row.id.startsWith(oldCsvId + '_')) {
          const idStart = lineText.indexOf(row.id);
          if (idStart >= 0) {
            const newId = row.id === oldCsvId ? newCsvId : row.id.replace(oldCsvId, newCsvId);
            const range = new vscode.Range(row.line, idStart, row.line, idStart + row.id.length);
            edit.replace(vscode.Uri.file(row.file), range, newId);
            csvCount++;
          }
        }
      }
    }

    if (declCount === 0) {
      throw new Error(`OdooLens: could not find a renameable "_name"/"_inherit" declaration for "${oldName}" (it may only be referenced, not declared, in this workspace).`);
    }

    const parts = [
      `${declCount} _name/_inherit declaration(s)`,
      `${envCount} self.env[...] reference(s)`,
    ];
    if (xmlCount) parts.push(`${xmlCount} XML model reference(s)`);
    if (csvCount) parts.push(`${csvCount} access-CSV cell(s)`);
    vscode.window.showWarningMessage(
      `OdooLens renamed ${parts.join(', ')} of "${oldName}" → "${newName}". ` +
        `Other cross-references (menus, actions, free-form strings, external ids outside the conventional model_* pattern) ` +
        `were left untouched — search the workspace for "${oldName}" to finish the rest by hand.`
    );
    return edit;
  }

  private notifyResult(
    kind: string,
    declCount: number,
    xmlCount: number,
    remainingCount: number,
    oldName: string,
    newName: string,
    modelName: string
  ): void {
    const parts: string[] = [`OdooLens renamed ${declCount} declaration site(s)`];
    if (xmlCount > 0) parts.push(`${xmlCount} XML reference(s)`);
    let message = `${parts.join(' and ')} of "${oldName}" → "${newName}" on ${modelName}.`;
    if (remainingCount > 0) {
      message +=
        ` ${remainingCount} additional static reference(s) (Python domains/attribute access, or XML occurrences ` +
        `OdooLens couldn't pinpoint exactly) were NOT renamed and must be updated manually — ` +
        `use "Odoo: Find Field Usages" on the old name to locate them.`;
      vscode.window.showWarningMessage(message);
    } else if (xmlCount > 0) {
      vscode.window.showInformationMessage(message);
    }
  }
}
