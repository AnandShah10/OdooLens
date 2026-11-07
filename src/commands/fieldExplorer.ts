import * as vscode from 'vscode';
import * as path from 'path';
import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { resolveModelContext } from '../language/ModelContextResolver';

function rel(file: string): string {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  return wsFolder ? path.relative(wsFolder.uri.fsPath, file) : file;
}

async function pickModel(index: OdooWorkspaceIndex): Promise<string | undefined> {
  const names = Array.from(index.models.keys()).sort();
  return vscode.window.showQuickPick(names, { placeHolder: 'Select an Odoo model' });
}

export function registerFieldExplorerCommands(context: vscode.ExtensionContext, index: OdooWorkspaceIndex): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('odooIntelligence.showModel', async () => {
      const name = await pickModel(index);
      if (!name) return;
      const model = index.getModel(name);
      if (!model) return;
      showModelPanel(name, model);
    }),

    vscode.commands.registerCommand('odooIntelligence.showFieldIntelligence', async () => {
      const editor = vscode.window.activeTextEditor;
      let model: string | undefined;
      let field: string | undefined;
      if (editor) {
        const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
        if (wordRange) {
          const ctx = resolveModelContext(index, editor.document, wordRange.start);
          if (ctx) {
            model = ctx.model;
            field = editor.document.getText(wordRange);
          }
        }
      }
      if (!model) model = await pickModel(index);
      if (!model) return;
      const m = index.getModel(model);
      if (!m) return;
      if (!field || !m.fields.has(field)) {
        field = await vscode.window.showQuickPick(Array.from(m.fields.keys()).sort(), { placeHolder: `Select a field on ${model}` });
      }
      if (!field) return;
      showFieldPanel(model, field, index);
    }),

    vscode.commands.registerCommand('odooIntelligence.findFieldUsages', async () => {
      const model = await pickModel(index);
      if (!model) return;
      const m = index.getModel(model);
      if (!m) return;
      const field = await vscode.window.showQuickPick(Array.from(m.fields.keys()).sort(), { placeHolder: `Field on ${model}` });
      if (!field) return;
      const usages = index.references.getFieldUsages(model, field);
      if (usages.length === 0) {
        vscode.window.showInformationMessage(`No statically-discovered usages of ${model}.${field}.`);
        return;
      }
      const locations = usages.map((u) => new vscode.Location(vscode.Uri.file(u.location.file), new vscode.Position(u.location.startLine, u.location.startCol)));
      await vscode.commands.executeCommand(
        'editor.action.showReferences',
        locations[0].uri,
        locations[0].range.start,
        locations
      );
    }),

    vscode.commands.registerCommand('odooIntelligence.goToFieldDefinition', async () => {
      const model = await pickModel(index);
      if (!model) return;
      const m = index.getModel(model);
      if (!m) return;
      const field = await vscode.window.showQuickPick(Array.from(m.fields.keys()).sort(), { placeHolder: `Field on ${model}` });
      if (!field) return;
      const decl = m.fields.get(field)!;
      const doc = await vscode.workspace.openTextDocument(decl.location.file);
      const editor = await vscode.window.showTextDocument(doc);
      editor.revealRange(new vscode.Range(decl.location.startLine, decl.location.startCol, decl.location.endLine, decl.location.endCol));
    })
  );
}

function showModelPanel(name: string, model: ReturnType<OdooWorkspaceIndex['getModel']>): void {
  if (!model) return;
  const panel = vscode.window.createWebviewPanel('odooModel', `Odoo Model: ${name}`, vscode.ViewColumn.Beside, { enableScripts: false });
  const fieldRows = Array.from(model.fields.values())
    .map((f) => `<tr><td><code>${f.name}</code></td><td>${f.fieldType}${f.comodel ? ` → ${f.comodel}` : ''}</td><td>${rel(f.location.file)}</td></tr>`)
    .join('\n');
  const methodRows = Array.from(model.methods.values())
    .map((m) => `<tr><td><code>${m.name}</code></td><td>${m.decorators.map((d) => '@' + d.name).join(', ')}</td><td>${rel(m.location.file)}</td></tr>`)
    .join('\n');
  panel.webview.html = `<!doctype html><html><body style="font-family:var(--vscode-font-family);padding:1em;">
    <h2>${name}</h2>
    <p>Declared across modules: ${Array.from(model.modules).join(', ')}</p>
    <h3>Fields (${model.fields.size})</h3>
    <table border="1" cellpadding="4" cellspacing="0"><tr><th>Name</th><th>Type</th><th>Declared in</th></tr>${fieldRows}</table>
    <h3>Methods (${model.methods.size})</h3>
    <table border="1" cellpadding="4" cellspacing="0"><tr><th>Name</th><th>Decorators</th><th>Declared in</th></tr>${methodRows}</table>
  </body></html>`;
}

function showFieldPanel(model: string, field: string, index: OdooWorkspaceIndex): void {
  const m = index.getModel(model);
  if (!m) return;
  const decl = m.fields.get(field);
  if (!decl) return;
  const history = m.fieldHistory.get(field) ?? [];
  const usages = index.references.getFieldUsages(model, field);
  const pyUsages = usages.filter((u) => u.kind !== 'xml-field');
  const xmlUsages = usages.filter((u) => u.kind === 'xml-field');

  const panel = vscode.window.createWebviewPanel('odooField', `Field: ${model}.${field}`, vscode.ViewColumn.Beside, { enableScripts: false });
  panel.webview.html = `<!doctype html><html><body style="font-family:var(--vscode-font-family);padding:1em;">
    <h2>${field}</h2>
    <p><b>Model:</b> ${model}<br/>
       <b>Type:</b> ${decl.fieldType}${decl.comodel ? ` → ${decl.comodel}` : ''}<br/>
       <b>Declared in:</b> ${rel(decl.location.file)} (module <code>${decl.module}</code>)<br/>
       ${decl.compute ? `<b>Computed by:</b> ${decl.compute}<br/><b>Depends on:</b> ${decl.dependsOn.join(', ') || '(none declared)'}<br/>` : ''}
       ${decl.related ? `<b>Related:</b> ${decl.related}<br/>` : ''}
    </p>
    <h3>Declaration history (${history.length})</h3>
    <ul>${history.map((h) => `<li>${h.module} — ${rel(h.location.file)}:${h.location.startLine + 1}</li>`).join('')}</ul>
    <h3>Usages (best-effort static approximation)</h3>
    <p>${pyUsages.length} Python reference(s), ${xmlUsages.length} XML view reference(s).</p>
    <ul>${usages.slice(0, 50).map((u) => `<li>${u.kind} — ${rel(u.location.file)}:${u.location.startLine + 1}</li>`).join('')}</ul>
    ${usages.length > 50 ? `<p>…and ${usages.length - 50} more.</p>` : ''}
  </body></html>`;
}
