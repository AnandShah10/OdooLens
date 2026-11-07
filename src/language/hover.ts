import * as vscode from 'vscode';
import * as path from 'path';
import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { resolveModelContext } from './ModelContextResolver';

export class OdooHoverProvider implements vscode.HoverProvider {
  constructor(private index: OdooWorkspaceIndex) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return null;
    const word = document.getText(wordRange);

    // Resolve context as of the START of the word (so hovering the field name itself works,
    // not just completion right after a trailing dot).
    const beforeWordPos = new vscode.Position(wordRange.start.line, wordRange.start.character);
    const ctx = resolveModelContext(this.index, document, beforeWordPos);
    if (!ctx) return null;
    const model = this.index.getModel(ctx.model);
    if (!model) return null;

    const field = model.fields.get(word);
    if (field) {
      const usages = this.index.references.getFieldUsages(ctx.model, word);
      const pyUsages = usages.filter((u) => u.kind !== 'xml-field').length;
      const xmlUsages = usages.filter((u) => u.kind === 'xml-field').length;
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`### ${word}\n\n`);
      md.appendMarkdown(`**Type:** ${field.fieldType}${field.comodel ? ` → \`${field.comodel}\`` : ''}\n\n`);
      md.appendMarkdown(`**Model:** \`${ctx.model}\` _(context confidence: ${ctx.confidence})_\n\n`);
      md.appendMarkdown(`**Defined in:** ${relativeDisplay(field.location.file)}\n\n`);
      if (field.compute) {
        md.appendMarkdown(`**Computed by:** \`${field.compute}\`\n\n`);
        if (field.dependsOn.length) md.appendMarkdown(`**Depends on:** ${field.dependsOn.join(', ')}\n\n`);
      }
      if (field.related) md.appendMarkdown(`**Related:** \`${field.related}\`\n\n`);
      md.appendMarkdown(`**Used by (statically found):** ${pyUsages} Python reference(s), ${xmlUsages} XML view reference(s)\n\n`);
      md.appendMarkdown(`_Counts are a best-effort static approximation — see OdooLens docs on reference-index limitations._`);
      return new vscode.Hover(md, wordRange);
    }

    const method = model.methods.get(word);
    if (method) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`### ${word}()\n\n`);
      md.appendMarkdown(`**Model:** \`${ctx.model}\`\n\n`);
      md.appendMarkdown(`**Defined in:** ${relativeDisplay(method.location.file)}\n\n`);
      const overrides = model.methodHistory.get(word) ?? [];
      if (overrides.length > 1) {
        md.appendMarkdown(`**Overridden ${overrides.length} times across modules:** ${overrides.map((o) => o.module).join(', ')}\n\n`);
      }
      if (method.decorators.length) {
        md.appendMarkdown(`**Decorators:** ${method.decorators.map((d) => '@' + d.name).join(', ')}\n\n`);
      }
      return new vscode.Hover(md, wordRange);
    }

    return null;
  }
}

function relativeDisplay(file: string): string {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (wsFolder) return path.relative(wsFolder.uri.fsPath, file);
  return file;
}
