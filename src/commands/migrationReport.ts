import * as vscode from 'vscode';
import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { runMigrationAnalyzer, MigrationFinding } from '../analyzer/migration/MigrationAnalyzer';
import { OdooVersion, detectMajorVersion } from '../versioning/MigrationRules';

const VERSIONS: OdooVersion[] = ['14', '15', '16', '17', '18', '19'];

export function registerMigrationReportCommand(context: vscode.ExtensionContext, index: OdooWorkspaceIndex): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('odooIntelligence.generateMigrationReport', async () => {
      if (!vscode.workspace.getConfiguration('odooIntelligence').get<boolean>('enableMigrationAnalyzer', true)) {
        vscode.window.showInformationMessage(
          'OdooLens: the migration analyzer is disabled (odooIntelligence.enableMigrationAnalyzer). Enable it in settings to generate a report.'
        );
        return;
      }
      const configuredVersion = vscode.workspace.getConfiguration('odooIntelligence').get<string>('odooVersion', 'auto');

      let from: OdooVersion | undefined;
      if (configuredVersion !== 'auto' && (VERSIONS as string[]).includes(configuredVersion)) {
        from = configuredVersion as OdooVersion;
      } else {
        const detected = detectMajorVersion(Array.from(index.modules.values()).map((m) => m.version));
        if (detected) {
          from = detected;
          vscode.window.showInformationMessage(
            `OdooLens: auto-detected Odoo ${detected} from module manifests (set odooIntelligence.odooVersion to override).`
          );
        } else {
          from = (await vscode.window.showQuickPick(VERSIONS, { placeHolder: 'Migrating FROM which Odoo version?' })) as
            | OdooVersion
            | undefined;
        }
      }
      if (!from) return;

      const to = await vscode.window.showQuickPick(VERSIONS.filter((v) => v > from!), { placeHolder: 'Migrating TO which Odoo version?' });
      if (!to) return;

      const allFindings: MigrationFinding[] = [];
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `OdooLens: scanning for ${from}→${to} migration issues…` },
        async () => {
          const fs = require('fs');
          const scan = (files: Iterable<string>, kind: 'python' | 'xml') => {
            for (const file of files) {
              let source: string;
              try {
                source = fs.readFileSync(file, 'utf8');
              } catch {
                continue;
              }
              allFindings.push(...runMigrationAnalyzer(file, source, from as OdooVersion, to as OdooVersion, kind));
            }
          };
          // XML files matter as much as Python ones: view-syntax rules (attrs=, <tree> -> <list>,
          // view_mode) target XML and previously could never fire, because only Python files
          // were ever scanned.
          scan(index.pythonFiles.keys(), 'python');
          scan(index.xmlFiles.keys(), 'xml');
        }
      );

      if (allFindings.length === 0) {
        vscode.window.showInformationMessage(`OdooLens: no known ${from}→${to} migration patterns found.`);
        return;
      }

      const byFile = new Map<string, MigrationFinding[]>();
      for (const f of allFindings) {
        const arr = byFile.get(f.file) ?? [];
        arr.push(f);
        byFile.set(f.file, arr);
      }

      const severityIcon = (s: string) => (s === 'error' ? '🔴' : s === 'warning' ? '🟠' : s === 'information' ? '🟢' : '⚪');
      const rows = Array.from(byFile.entries())
        .map(
          ([file, findings]) =>
            `<h3>${file} (${findings.length})</h3><ul>${findings
              .map(
                (f) =>
                  `<li>${severityIcon(f.rule.severity)} <b>${f.rule.id}</b> — line ${f.line + 1}: ${escapeHtml(f.rule.message)} ` +
                  `<br/><small>Confidence: ${f.rule.confidence} · Estimated effort: ${f.rule.estimatedEffort} · Auto-fix: ${
                    f.rule.isSafeAutoFix ? 'available' : 'manual review required'
                  }</small></li>`
              )
              .join('')}</ul>`
        )
        .join('');

      const panel = vscode.window.createWebviewPanel(
        'odooMigrationReport',
        `Migration Report ${from}→${to}`,
        vscode.ViewColumn.Beside,
        { enableScripts: false }
      );
      panel.webview.html = `<!doctype html><html><body style="font-family:var(--vscode-font-family);padding:1em;">
        <h2>Migration Analysis: Odoo ${from} → ${to}</h2>
        <p>${allFindings.length} finding(s) across ${byFile.size} file(s).</p>
        ${rows}
      </body></html>`;
    })
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
