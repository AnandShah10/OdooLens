import * as vscode from 'vscode';
import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { resolveModelContext } from './ModelContextResolver';
import { toLocation } from '../utils/VscodeConvert';

export class OdooDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private index: OdooWorkspaceIndex) {}

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | null {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return null;
    const word = document.getText(wordRange);

    // Special-case: cursor is inside a self.env['model.name'] string literal -> jump to the
    // model's primary (first) declaration.
    const line = document.lineAt(position.line).text;
    const envStringMatch = matchEnvStringAt(line, position.character);
    if (envStringMatch) {
      const model = this.index.getModel(envStringMatch);
      if (model && model.contributions.length > 0) {
        return model.contributions.map((c) => toLocation(c.location));
      }
      return null;
    }

    const ctx = resolveModelContext(this.index, document, new vscode.Position(wordRange.start.line, wordRange.start.character));
    if (!ctx) return null;
    const model = this.index.getModel(ctx.model);
    if (!model) return null;

    const fieldHistory = model.fieldHistory.get(word);
    if (fieldHistory && fieldHistory.length > 0) {
      return fieldHistory.map((f) => toLocation(f.location));
    }
    const methodHistory = model.methodHistory.get(word);
    if (methodHistory && methodHistory.length > 0) {
      return methodHistory.map((m) => toLocation(m.location));
    }
    return null;
  }
}

function matchEnvStringAt(line: string, col: number): string | null {
  const re = /self\.env\[\s*(['"])([\w.]+)\1\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (col >= m.index && col <= m.index + m[0].length) return m[2];
  }
  return null;
}
