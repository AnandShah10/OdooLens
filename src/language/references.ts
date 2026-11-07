import * as vscode from 'vscode';
import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { resolveModelContext } from './ModelContextResolver';
import { toLocation } from '../utils/VscodeConvert';
import { findDescendants } from '../parser/xml/XmlParser';

/**
 * VS Code "Find All References" for Odoo fields, methods, and model-name string literals.
 * Backed by the shared semantic index — same data hover / impact / rename already use.
 */
export class OdooReferenceProvider implements vscode.ReferenceProvider {
  constructor(private index: OdooWorkspaceIndex) {}

  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext
  ): vscode.Location[] {
    const results: vscode.Location[] = [];

    // Model name inside a quoted string (self.env['x.y'] or _name = 'x.y')
    const line = document.lineAt(position.line).text;
    const modelHit = matchModelStringAt(line, position.character, this.index);
    if (modelHit) {
      const model = this.index.getModel(modelHit);
      if (model) {
        if (context.includeDeclaration) {
          for (const c of model.contributions) {
            if (c.nameLocation) results.push(toLocation(c.nameLocation));
            else results.push(toLocation(c.location));
            for (const loc of c.inheritLocations) results.push(toLocation(loc));
          }
        }
        for (const usage of this.index.references.getModelUsages(modelHit)) {
          results.push(toLocation(usage.location));
        }
        // env accesses across all methods
        for (const analysis of this.index.pythonFiles.values()) {
          for (const contrib of analysis.modelContributions) {
            for (const method of contrib.methods) {
              for (const access of method.envAccesses) {
                if (access.model === modelHit) {
                  results.push(toLocation(access.keyLocation));
                }
              }
            }
          }
        }
        // Views bound to this model
        for (const view of this.index.viewsById.values()) {
          if (view.model === modelHit) results.push(toLocation(view.location));
        }
      }
      return dedupeLocations(results);
    }

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return [];
    const word = document.getText(wordRange);
    const ctx = resolveModelContext(this.index, document, wordRange.start);
    if (!ctx) return [];
    const model = this.index.getModel(ctx.model);
    if (!model) return [];

    // Field references
    if (model.fields.has(word)) {
      if (context.includeDeclaration) {
        for (const decl of model.fieldHistory.get(word) ?? []) {
          results.push(toLocation(decl.nameLocation ?? decl.location));
        }
      }
      for (const usage of this.index.references.getFieldUsages(ctx.model, word)) {
        results.push(toLocation(usage.location));
      }
      return dedupeLocations(results);
    }

    // Method references
    if (model.methods.has(word)) {
      if (context.includeDeclaration) {
        for (const decl of model.methodHistory.get(word) ?? []) {
          results.push(toLocation(decl.nameLocation ?? decl.location));
        }
      }
      // Python self.method() call sites (when locations are tracked)
      for (const [, m] of model.methods) {
        for (const site of m.calledMethodSites ?? []) {
          if (site.name === word) results.push(toLocation(site.location));
        }
      }
      // XML <button type="object" name="...">
      for (const view of this.index.viewsById.values()) {
        if (view.model !== ctx.model || !view.archNode) continue;
        for (const button of findDescendants(view.archNode, 'button')) {
          if (button.attributes.type === 'object' && button.attributes.name === word) {
            results.push(toLocation(button.location));
          }
        }
      }
      return dedupeLocations(results);
    }

    return [];
  }
}

function matchModelStringAt(line: string, col: number, index: OdooWorkspaceIndex): string | null {
  const re = /(['"])([\w.]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const contentStart = m.index + 1;
    const contentEnd = contentStart + m[2].length;
    if (col >= contentStart && col <= contentEnd && index.models.has(m[2])) return m[2];
  }
  return null;
}

function dedupeLocations(locs: vscode.Location[]): vscode.Location[] {
  const seen = new Set<string>();
  const out: vscode.Location[] = [];
  for (const loc of locs) {
    const key = `${loc.uri.fsPath}:${loc.range.start.line}:${loc.range.start.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(loc);
  }
  return out;
}
