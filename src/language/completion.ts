import * as vscode from 'vscode';
import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { resolveModelContext } from './ModelContextResolver';

export class OdooCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private index: OdooWorkspaceIndex) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const ctx = resolveModelContext(this.index, document, position);
    if (!ctx) return [];
    const model = this.index.getModel(ctx.model);
    if (!model) return [];

    const items: vscode.CompletionItem[] = [];
    for (const [name, field] of model.fields) {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
      item.detail = `${field.fieldType}${field.comodel ? `(${field.comodel})` : ''} — ${ctx.model}`;
      item.documentation = new vscode.MarkdownString(fieldDocMarkdown(field, ctx.model));
      items.push(item);
    }
    for (const [name, method] of model.methods) {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
      const decoratorSuffix = method.decorators.length ? ` (${method.decorators.map((d) => '@' + d.name).join(', ')})` : '';
      item.detail = `method — ${ctx.model}${decoratorSuffix}`;
      item.insertText = new vscode.SnippetString(`${name}()`);
      items.push(item);
    }
    return items;
  }
}

function fieldDocMarkdown(field: { fieldType: string; compute?: string; dependsOn: string[]; module: string }, model: string): string {
  const lines = [`**${field.fieldType}** on \`${model}\``];
  if (field.compute) lines.push(`Computed by \`${field.compute}\`, depends on: ${field.dependsOn.join(', ') || '(none declared)'}`);
  lines.push(`Declared in module \`${field.module}\``);
  return lines.join('\n\n');
}
