import * as vscode from 'vscode';
import * as path from 'path';
import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { DiagnosticsManager } from '../analyzer/DiagnosticsManager';
import { Logger } from '../utils/Logger';

/** Resolves `odooIntelligence.addonsPaths` (relative-to-first-workspace-folder or absolute)
 *  into absolute directory paths, so `Odoo: Rebuild Index` also scans addons that live outside
 *  the open workspace folders — e.g. a separate `enterprise/` or `custom-addons/` checkout. */
function resolveAddonsPaths(folders: readonly vscode.WorkspaceFolder[]): string[] {
  const configured = vscode.workspace.getConfiguration('odooIntelligence').get<string[]>('addonsPaths', []);
  if (!configured || configured.length === 0) return [];
  const base = folders[0]?.uri.fsPath;
  return configured.map((p) => (path.isAbsolute(p) ? p : path.resolve(base, p)));
}

export function registerRebuildIndexCommands(
  context: vscode.ExtensionContext,
  index: OdooWorkspaceIndex,
  diagnostics: DiagnosticsManager,
  logger: Logger,
  statusBar: vscode.StatusBarItem,
  onIndexChanged: () => void = () => undefined
): void {
  const rebuild = async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showWarningMessage('OdooLens: open a folder or workspace containing Odoo modules first.');
      return;
    }
    statusBar.text = '$(sync~spin) OdooLens: indexing…';
    statusBar.show();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'OdooLens: analyzing workspace', cancellable: true },
      async (progress, token) => {
        progress.report({ message: 'Discovering modules and parsing files…' });
        const addonsPaths = resolveAddonsPaths(folders);
        const roots = [...folders.map((f) => f.uri.fsPath), ...addonsPaths];
        const stats = await index.buildFull(roots, { isCancelled: () => token.isCancellationRequested });
        logger.info(
          `Indexed ${stats.moduleCount} module(s), ${stats.pythonFileCount} Python file(s) ` +
            `(${stats.cacheHitCount} from cache), ${stats.xmlFileCount} XML file(s), ${stats.modelCount} logical ` +
            `model(s) in ${stats.buildTimeMs}ms (${stats.parseErrorCount} parse error(s))` +
            (addonsPaths.length ? `, including ${addonsPaths.length} configured addons path(s).` : '.')
        );
        if (stats.cancelled) {
          logger.warning(
            `Indexing cancelled — partial index (${stats.pythonFileCount} Python / ${stats.xmlFileCount} XML file(s) ` +
              `processed). Run "Odoo: Rebuild Index" again to finish; already-parsed Python files are cached.`
          );
          vscode.window.showWarningMessage('OdooLens: indexing cancelled — results are partial until you rebuild the index.');
        }
        if (stats.parseErrorCount > 0) {
          logger.warning(`${stats.parseErrorCount} file(s) had parse errors — see above for which ones were skipped.`);
        }
        progress.report({ message: 'Running analyzers…' });
        diagnostics.refreshAllFiles();
        onIndexChanged();
      }
    );
    statusBar.text = `$(check) OdooLens: ${index.models.size} models, ${index.modules.size} modules`;
    vscode.window.setStatusBarMessage('OdooLens: workspace analysis complete.', 4000);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('odooIntelligence.analyzeWorkspace', rebuild),
    vscode.commands.registerCommand('odooIntelligence.rebuildIndex', rebuild),
    vscode.commands.registerCommand('odooIntelligence.clearIndexCache', async () => {
      if (!index.cacheFilePath) {
        vscode.window.showInformationMessage('OdooLens: no persistent cache is active for this workspace (no storage location available).');
        return;
      }
      try {
        const fs = require('fs');
        if (fs.existsSync(index.cacheFilePath)) fs.unlinkSync(index.cacheFilePath);
        logger.info('Cleared the persistent Python-analysis cache.');
        vscode.window.showInformationMessage('OdooLens: cache cleared. Run "Odoo: Rebuild Index" to re-parse everything from scratch.');
      } catch (err) {
        vscode.window.showErrorMessage(`OdooLens: failed to clear the cache: ${String(err)}`);
      }
    })
  );
}
