import * as vscode from 'vscode';
import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { analyzeImpact } from '../analyzer/ImpactAnalyzer';

export function registerImpactAnalyzerCommand(context: vscode.ExtensionContext, index: OdooWorkspaceIndex): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('odooIntelligence.analyzeImpact', async () => {
      const editor = vscode.window.activeTextEditor;
      let model: string | undefined;
      let method: string | undefined;

      if (editor) {
        const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
        if (wordRange) {
          const word = editor.document.getText(wordRange);
          const analysis = index.pythonFiles.get(editor.document.fileName);
          if (analysis) {
            for (const contribution of analysis.modelContributions) {
              if (contribution.location.startLine <= wordRange.start.line && wordRange.start.line <= contribution.location.endLine) {
                const m = contribution.name ?? contribution.inherit[0];
                if (m && contribution.methods.some((mm) => mm.name === word)) {
                  model = m;
                  method = word;
                }
              }
            }
          }
        }
      }

      if (!model) {
        const modelNames = Array.from(index.models.keys()).sort();
        model = await vscode.window.showQuickPick(modelNames, { placeHolder: 'Select a model' });
        if (!model) return;
      }
      if (!method) {
        const m = index.getModel(model);
        if (!m) return;
        method = await vscode.window.showQuickPick(Array.from(m.methods.keys()).sort(), { placeHolder: `Method on ${model}` });
        if (!method) return;
      }

      const result = analyzeImpact(index, model, method);
      const panel = vscode.window.createWebviewPanel('odooImpact', `Impact: ${model}.${method}`, vscode.ViewColumn.Beside, {
        enableScripts: false,
      });
      panel.webview.html = `<!doctype html><html><body style="font-family:var(--vscode-font-family);padding:1em;">
        <h2>${method}() on ${model}</h2>
        <h3>Inherited/overridden by (${result.inheritedBy.length})</h3>
        <ul>${result.inheritedBy.map((i) => `<li>${i.module} — ${i.location.file}:${i.location.startLine + 1}</li>`).join('') || '<li><i>none found</i></li>'}</ul>
        <h3>Called from Python (${result.calledFromPython.length})</h3>
        <ul>${result.calledFromPython.map((c) => `<li>${c.model}.${c.method}() — ${c.location.file}:${c.location.startLine + 1}</li>`).join('') || '<li><i>none found</i></li>'}</ul>
        <h3>Referenced from XML buttons (${result.calledFromXmlButtons.length})</h3>
        <ul>${result.calledFromXmlButtons.map((b) => `<li>${b.xmlId} — ${b.file}:${b.location.startLine + 1}</li>`).join('') || '<li><i>none found</i></li>'}</ul>
        <h3>Referenced from scheduled/server actions (${result.calledFromAutomation.length})</h3>
        <ul>${result.calledFromAutomation.map((a) => `<li>[${a.kind}] ${a.name ?? a.xmlId} — ${a.file}:${a.location.startLine + 1}</li>`).join('') || '<li><i>none found</i></li>'}</ul>
        <h3>RPC-reachable ${result.rpcReachability.reachable ? '⚠️ yes' : '✓ no'}</h3>
        <p>${result.rpcReachability.reason}</p>
        <p><i>${result.confidenceNote}</i></p>
      </body></html>`;
    })
  );
}
