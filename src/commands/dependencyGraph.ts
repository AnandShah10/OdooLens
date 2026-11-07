import * as vscode from 'vscode';
import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { DependencyGraphPanel, buildModelGraph, buildModuleGraph, buildUnifiedModelGraph } from '../webview/graph/DependencyGraphPanel';

export function registerDependencyGraphCommands(context: vscode.ExtensionContext, index: OdooWorkspaceIndex): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('odooIntelligence.showDependencyGraph', async () => {
      const choice = await vscode.window.showQuickPick(
        ['Module dependency graph', 'Model relationship graph', 'Unified model graph (fields, methods, views, automation, security)'],
        { placeHolder: 'Which graph?' }
      );
      if (!choice) return;

      if (choice.startsWith('Module')) {
        const moduleNames = Array.from(index.modules.keys()).sort();
        const focus = await vscode.window.showQuickPick(['(all modules)', ...moduleNames], { placeHolder: 'Focus on a module?' });
        if (!focus) return;
        const data = buildModuleGraph(index, focus === '(all modules)' ? undefined : focus);
        const fileLookup: Record<string, string> = {};
        for (const [name, manifest] of index.modules) fileLookup[name] = manifest.location.file;
        DependencyGraphPanel.show(context.extensionUri, data, fileLookup);
        return;
      }

      const modelNames = Array.from(index.models.keys()).sort();
      const model = await vscode.window.showQuickPick(modelNames, { placeHolder: 'Select a model' });
      if (!model) return;
      const m = index.getModel(model);

      if (choice.startsWith('Model relationship')) {
        const data = buildModelGraph(index, model);
        const fileLookup: Record<string, string> = {};
        if (m) for (const c of m.contributions) fileLookup[model] = c.location.file;
        for (const view of index.viewsById.values()) fileLookup[`view:${view.xmlId}`] = view.file;
        DependencyGraphPanel.show(context.extensionUri, data, fileLookup);
        return;
      }

      // Unified model graph: build a fileLookup entry for every node kind the graph can emit,
      // so clicking any field/method/view/cron/action/access-row/rule node opens its real source.
      const data = buildUnifiedModelGraph(index, model);
      const fileLookup: Record<string, string> = {};
      if (m) {
        if (m.contributions.length > 0) fileLookup[model] = m.contributions[0].location.file;
        for (const field of m.fields.values()) fileLookup[`field:${model}.${field.name}`] = field.location.file;
        for (const method of m.methods.values()) fileLookup[`method:${model}.${method.name}`] = method.location.file;
      }
      for (const view of index.viewsById.values()) {
        if (view.model === model) fileLookup[`view:${view.xmlId}`] = view.file;
      }
      for (const cron of index.cronRecords) {
        if (cron.model === model) fileLookup[`cron:${cron.xmlId}`] = cron.file;
      }
      for (const action of index.serverActionRecords) {
        if (action.model === model) fileLookup[`action:${action.xmlId}`] = action.file;
      }
      for (const rule of index.ruleRecords) {
        if (rule.model === model) fileLookup[`rule:${rule.xmlId}`] = rule.file;
      }
      for (const row of index.accessRules) {
        const suffix = row.modelId.includes('.') ? row.modelId.split('.').pop()! : row.modelId;
        if (suffix === `model_${model.replace(/\./g, '_')}`) fileLookup[`access:${row.id}`] = row.file;
      }
      DependencyGraphPanel.show(context.extensionUri, data, fileLookup);
    })
  );
}
