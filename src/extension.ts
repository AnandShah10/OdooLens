import * as vscode from 'vscode';
import { OdooWorkspaceIndex } from './index/OdooIndex';
import { DiagnosticsManager } from './analyzer/DiagnosticsManager';
import { OdooCompletionProvider } from './language/completion';
import { OdooHoverProvider } from './language/hover';
import { OdooDefinitionProvider } from './language/definition';
import { OdooCodeActionProvider } from './language/codeActions';
import { OdooSymbolProvider } from './language/symbols';
import { OdooRenameProvider } from './language/rename';
import { OdooReferenceProvider } from './language/references';
import { registerRebuildIndexCommands } from './commands/analyzeWorkspace';
import { registerFieldExplorerCommands } from './commands/fieldExplorer';
import { registerDependencyGraphCommands } from './commands/dependencyGraph';
import { registerViewVisualizerCommand } from './commands/viewVisualizer';
import { registerImpactAnalyzerCommand } from './commands/impactAnalyzer';
import { registerMigrationReportCommand } from './commands/migrationReport';
import { registerRuntimeCommands } from './commands/registryInspector';
import { registerLogNavigatorCommand } from './commands/logNavigator';
import { Logger } from './utils/Logger';
import { ExplorerProvider, OPEN_LOCATION_COMMAND, openLocation } from './views/ExplorerProvider';
import { buildModelTreeRoots, buildModuleTreeRoots, buildProblemsTreeRoots } from './views/TreeData';

let debounceTimer: NodeJS.Timeout | undefined;
const DEBOUNCE_MS = 600;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration('odooIntelligence');
  if (!cfg.get<boolean>('enabled', true)) {
    return;
  }

  const output = vscode.window.createOutputChannel('OdooLens');
  context.subscriptions.push(output);
  const logger = new Logger(output);
  logger.info('Activating…');

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(circuit-board) OdooLens';
  statusBarItem.command = 'odooIntelligence.analyzeWorkspace';
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();

  const index = new OdooWorkspaceIndex(context.extensionPath);
  // context.storageUri is a per-workspace folder VS Code provides specifically for this kind of
  // thing; undefined only when there's no open workspace (e.g. a single ungrouped file), in
  // which case the index simply runs without a persistent cache for this session.
  if (context.storageUri) {
    index.cacheFilePath = vscode.Uri.joinPath(context.storageUri, 'python-analysis-cache.json').fsPath;
  }
  const diagnostics = new DiagnosticsManager(index);
  context.subscriptions.push({ dispose: () => diagnostics.dispose() });

  // Language features are registered for Python and XML documents workspace-wide; they degrade
  // gracefully (return nothing) whenever a file/position can't be resolved against the index.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider({ language: 'python' }, new OdooCompletionProvider(index), '.'),
    vscode.languages.registerHoverProvider({ language: 'python' }, new OdooHoverProvider(index)),
    vscode.languages.registerDefinitionProvider({ language: 'python' }, new OdooDefinitionProvider(index)),
    vscode.languages.registerCodeActionsProvider(
      [{ language: 'python' }, { language: 'xml' }],
      new OdooCodeActionProvider(),
      { providedCodeActionKinds: OdooCodeActionProvider.providedCodeActionKinds }
    ),
    vscode.languages.registerWorkspaceSymbolProvider(new OdooSymbolProvider(index)),
    vscode.languages.registerRenameProvider({ language: 'python' }, new OdooRenameProvider(index)),
    vscode.languages.registerReferenceProvider({ language: 'python' }, new OdooReferenceProvider(index))
  );

  // Sidebar explorers (Models / Modules / Problems). Models and Modules re-render whenever the
  // index changes (full rebuild or incremental file update); Problems re-renders whenever
  // DiagnosticsManager publishes — it exposes an event for exactly this.
  const modelExplorer = new ExplorerProvider(() => buildModelTreeRoots(index));
  const moduleExplorer = new ExplorerProvider(() => buildModuleTreeRoots(index));
  const problemsExplorer = new ExplorerProvider(() => buildProblemsTreeRoots(diagnostics.getAllDiagnostics()));
  const refreshIndexViews = () => {
    modelExplorer.refresh();
    moduleExplorer.refresh();
  };
  context.subscriptions.push(
    vscode.window.createTreeView('odooIntelligence.modelExplorer', { treeDataProvider: modelExplorer }),
    vscode.window.createTreeView('odooIntelligence.moduleExplorer', { treeDataProvider: moduleExplorer }),
    vscode.window.createTreeView('odooIntelligence.problemsExplorer', { treeDataProvider: problemsExplorer }),
    diagnostics.onDidChangeDiagnostics(() => problemsExplorer.refresh()),
    vscode.commands.registerCommand(OPEN_LOCATION_COMMAND, openLocation)
  );

  registerRebuildIndexCommands(context, index, diagnostics, logger, statusBarItem, refreshIndexViews);
  registerFieldExplorerCommands(context, index);
  registerDependencyGraphCommands(context, index);
  registerViewVisualizerCommand(context, index);
  registerImpactAnalyzerCommand(context, index);
  registerMigrationReportCommand(context, index);
  registerRuntimeCommands(context, index);
  registerLogNavigatorCommand(context, index);

  // File watchers: debounce per-file re-index + diagnostics refresh so rapid typing doesn't
  // trigger a full workspace rescan (see OdooWorkspaceIndex.updateFile doc comment for the
  // documented limitation that inheritance merging still recomputes on every update).
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{py,xml}');
  const scheduleUpdate = (uri: vscode.Uri) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const moduleName = index.moduleOf(uri.fsPath);
      if (!moduleName) return; // Not inside a discovered Odoo module; ignore.
      try {
        await index.updateFile(uri.fsPath, moduleName);
        diagnostics.refreshFile(uri.fsPath);
        diagnostics.refreshWorkspaceWideDiagnostics();
        refreshIndexViews();
      } catch (err) {
        logger.error(`Failed to re-index ${uri.fsPath}: ${String(err)}`);
      }
    }, DEBOUNCE_MS);
  };
  watcher.onDidChange(scheduleUpdate);
  watcher.onDidCreate(scheduleUpdate);
  watcher.onDidDelete((uri) => {
    index.pythonFiles.delete(uri.fsPath);
    index.xmlFiles.delete(uri.fsPath);
    diagnostics.refreshAllFiles();
    refreshIndexViews();
  });
  context.subscriptions.push(watcher);

  // Manifest changes require a full rebuild (dependency graph may have changed).
  const manifestWatcher = vscode.workspace.createFileSystemWatcher('**/__manifest__.py');
  manifestWatcher.onDidChange(() => vscode.commands.executeCommand('odooIntelligence.rebuildIndex'));
  manifestWatcher.onDidCreate(() => vscode.commands.executeCommand('odooIntelligence.rebuildIndex'));
  manifestWatcher.onDidDelete(() => vscode.commands.executeCommand('odooIntelligence.rebuildIndex'));
  context.subscriptions.push(manifestWatcher);

  // Kick off an initial index build if the workspace looks like it contains Odoo modules.
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    vscode.commands.executeCommand('odooIntelligence.rebuildIndex');
  }

  logger.info('Activated.');
}

export function deactivate(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
}
