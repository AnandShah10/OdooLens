import * as vscode from 'vscode';
import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { toLocation } from '../utils/VscodeConvert';

/**
 * Exposes every indexed model/field/method to VS Code's workspace-wide "Go to Symbol"
 * (Ctrl+T / Cmd+T), so `sale.order`, a field like `x_customer_score`, or a method like
 * `action_confirm` can all be jumped to without knowing which file declares them.
 */
export class OdooSymbolProvider implements vscode.WorkspaceSymbolProvider {
  constructor(private index: OdooWorkspaceIndex) {}

  provideWorkspaceSymbols(query: string): vscode.SymbolInformation[] {
    const q = query.toLowerCase();
    const results: vscode.SymbolInformation[] = [];
    const matches = (name: string) => q.length === 0 || name.toLowerCase().includes(q);

    for (const [modelName, model] of this.index.models) {
      if (matches(modelName) && model.contributions.length > 0) {
        results.push(
          new vscode.SymbolInformation(
            modelName,
            vscode.SymbolKind.Class,
            'Odoo model',
            toLocation(model.contributions[0].location)
          )
        );
      }
      for (const [fieldName, field] of model.fields) {
        if (matches(fieldName)) {
          results.push(
            new vscode.SymbolInformation(fieldName, vscode.SymbolKind.Field, modelName, toLocation(field.location))
          );
        }
      }
      for (const [methodName, method] of model.methods) {
        if (matches(methodName)) {
          results.push(
            new vscode.SymbolInformation(methodName, vscode.SymbolKind.Method, modelName, toLocation(method.location))
          );
        }
      }
      if (results.length > 500) break; // Cap result size defensively for huge workspaces.
    }
    return results;
  }
}
