import * as vscode from 'vscode';
import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { parseOdooLog, aggregateRecurringErrors } from '../analyzer/logs/LogNavigator';

export function registerLogNavigatorCommand(context: vscode.ExtensionContext, index: OdooWorkspaceIndex): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('odooIntelligence.analyzeLog', async () => {
      const source = await vscode.window.showQuickPick(['Use active editor contents', 'Open a log file…'], {
        placeHolder: 'Where should OdooLens read the log from?',
      });
      if (!source) return;

      let logText: string | undefined;
      if (source === 'Use active editor contents') {
        logText = vscode.window.activeTextEditor?.document.getText();
        if (!logText) {
          vscode.window.showWarningMessage('OdooLens: no active editor with content.');
          return;
        }
      } else {
        const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Log files': ['log', 'txt'] } });
        if (!uris || uris.length === 0) return;
        const doc = await vscode.workspace.openTextDocument(uris[0]);
        logText = doc.getText();
      }

      const errors = parseOdooLog(logText);
      if (errors.length === 0) {
        vscode.window.showInformationMessage('OdooLens: no recognizable Odoo tracebacks/exceptions found in that log.');
        return;
      }
      const aggregated = aggregateRecurringErrors(errors);

      const rows = aggregated
        .map((group) => {
          const err = group.sample;
          const lastFrame = err.frames[err.frames.length - 1];
          const moduleGuess = lastFrame ? index.moduleOf(lastFrame.file) ?? '(unknown module)' : '(no frame)';
          return `<li>
            <b>${group.count} occurrence(s)</b> — ❌ ${err.exceptionType}<br/>
            Module: ${moduleGuess}<br/>
            ${lastFrame ? `Location: ${lastFrame.file}:${lastFrame.line} in ${lastFrame.functionName}` : ''}<br/>
            <span class="msg">${escapeHtml(err.message)}</span>
          </li>`;
        })
        .join('');

      const panel = vscode.window.createWebviewPanel('odooLog', 'OdooLens Log Analysis', vscode.ViewColumn.Beside, {
        enableScripts: false,
      });
      panel.webview.html = `<!doctype html><html><body style="font-family:var(--vscode-font-family);padding:1em;">
        <h2>Odoo Log Analysis</h2>
        <p>${errors.length} error occurrence(s), grouped into ${aggregated.length} recurring pattern(s).</p>
        <ul>${rows}</ul>
      </body></html>`;
    })
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
