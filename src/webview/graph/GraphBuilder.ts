import { OdooWorkspaceIndex } from '../../index/OdooIndex';

/**
 * Pure graph-construction logic for the dependency graph webview, deliberately kept free of any
 * `vscode` import — unlike `DependencyGraphPanel.ts` (which renders these into a webview and
 * therefore must import `vscode`), this file can be unit-tested directly with plain mocha, the
 * same way the parser/index/analyzer layers are. Splitting it out this way is itself a fix for
 * a real gap: these functions previously lived in `DependencyGraphPanel.ts` and were completely
 * untestable by the unit suite, since importing anything from a file with a top-level `import
 * vscode` fails outside a real Extension Host (`Cannot find module 'vscode'`).
 */

export interface GraphNode {
  id: string;
  label: string;
  kind: 'module' | 'model' | 'field' | 'method' | 'view' | 'cron' | 'serverAction' | 'accessRule' | 'recordRule' | 'category';
}
export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  title: string;
}

export function buildModuleGraph(index: OdooWorkspaceIndex, focusModule?: string): GraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const modules = focusModule
    ? new Set([focusModule, ...index.modules.get(focusModule)!.depends, ...index.reverseModuleDependents(focusModule)])
    : new Set(index.modules.keys());

  for (const name of modules) {
    if (!index.modules.has(name)) continue;
    nodes.push({ id: name, label: name, kind: 'module' });
  }
  for (const name of modules) {
    const manifest = index.modules.get(name);
    if (!manifest) continue;
    for (const dep of manifest.depends) {
      if (modules.has(dep)) edges.push({ from: name, to: dep, label: 'depends on' });
    }
  }
  return { nodes, edges, title: focusModule ? `Module dependencies: ${focusModule}` : 'Module dependency graph' };
}

export function buildModelGraph(index: OdooWorkspaceIndex, modelName: string): GraphData {
  const model = index.getModel(modelName);
  const nodes: GraphNode[] = [{ id: modelName, label: modelName, kind: 'model' }];
  const edges: GraphEdge[] = [];
  if (!model) return { nodes, edges, title: modelName };

  for (const moduleName of model.modules) {
    nodes.push({ id: `module:${moduleName}`, label: moduleName, kind: 'module' });
    edges.push({ from: `module:${moduleName}`, to: modelName, label: 'contributes to' });
  }
  // Relational fields become edges to their comodel.
  for (const field of model.fields.values()) {
    if (field.comodel) {
      nodes.push({ id: field.comodel, label: field.comodel, kind: 'model' });
      edges.push({ from: modelName, to: field.comodel, label: field.name });
    }
  }
  for (const view of index.viewsById.values()) {
    if (view.model === modelName) {
      nodes.push({ id: `view:${view.xmlId}`, label: view.xmlId, kind: 'view' });
      edges.push({ from: modelName, to: `view:${view.xmlId}`, label: 'view' });
    }
  }
  return { nodes: dedupeNodes(nodes), edges, title: `Model graph: ${modelName}` };
}

/**
 * The "unified" model graph: one tree covering modules, fields (ALL of them, not just
 * relational ones — relational fields additionally get an edge out to their comodel), methods,
 * views, scheduled actions (ir.cron), server actions (ir.actions.server), and security
 * (ir.model.access.csv rows + ir.rule record rules) — matching the original spec's ask for a
 * single graph spanning "fields, methods, views, server actions, cron jobs, security rules, and
 * modules" rather than the narrower module/comodel/view-only `buildModelGraph` above. Each
 * category is grouped under its own intermediate node so the graph stays legible instead of
 * becoming an unreadable hairball when a model has e.g. 60 fields.
 */
export function buildUnifiedModelGraph(index: OdooWorkspaceIndex, modelName: string): GraphData {
  const model = index.getModel(modelName);
  const nodes: GraphNode[] = [{ id: modelName, label: modelName, kind: 'model' }];
  const edges: GraphEdge[] = [];
  if (!model) return { nodes, edges, title: modelName };

  const addCategory = (id: string, label: string): void => {
    nodes.push({ id, label, kind: 'category' });
    edges.push({ from: modelName, to: id });
  };

  if (model.modules.size > 0) {
    const catId = `cat:modules:${modelName}`;
    addCategory(catId, `Modules (${model.modules.size})`);
    for (const m of model.modules) {
      nodes.push({ id: `module:${m}`, label: m, kind: 'module' });
      edges.push({ from: catId, to: `module:${m}` });
    }
  }

  if (model.fields.size > 0) {
    const catId = `cat:fields:${modelName}`;
    addCategory(catId, `Fields (${model.fields.size})`);
    for (const field of model.fields.values()) {
      const fieldId = `field:${modelName}.${field.name}`;
      nodes.push({ id: fieldId, label: field.name, kind: 'field' });
      edges.push({ from: catId, to: fieldId });
      if (field.comodel) {
        nodes.push({ id: field.comodel, label: field.comodel, kind: 'model' });
        edges.push({ from: fieldId, to: field.comodel, label: 'comodel' });
      }
    }
  }

  if (model.methods.size > 0) {
    const catId = `cat:methods:${modelName}`;
    addCategory(catId, `Methods (${model.methods.size})`);
    for (const method of model.methods.values()) {
      const methodId = `method:${modelName}.${method.name}`;
      nodes.push({ id: methodId, label: `${method.name}()`, kind: 'method' });
      edges.push({ from: catId, to: methodId });
    }
  }

  const views = Array.from(index.viewsById.values()).filter((v) => v.model === modelName);
  if (views.length > 0) {
    const catId = `cat:views:${modelName}`;
    addCategory(catId, `Views (${views.length})`);
    for (const view of views) {
      nodes.push({ id: `view:${view.xmlId}`, label: view.xmlId, kind: 'view' });
      edges.push({ from: catId, to: `view:${view.xmlId}` });
    }
  }

  const crons = index.cronRecords.filter((c) => c.model === modelName);
  if (crons.length > 0) {
    const catId = `cat:cron:${modelName}`;
    addCategory(catId, `Scheduled Actions (${crons.length})`);
    for (const cron of crons) {
      nodes.push({ id: `cron:${cron.xmlId}`, label: cron.name ?? cron.xmlId, kind: 'cron' });
      edges.push({ from: catId, to: `cron:${cron.xmlId}` });
    }
  }

  const serverActions = index.serverActionRecords.filter((a) => a.model === modelName);
  if (serverActions.length > 0) {
    const catId = `cat:actions:${modelName}`;
    addCategory(catId, `Server Actions (${serverActions.length})`);
    for (const action of serverActions) {
      nodes.push({ id: `action:${action.xmlId}`, label: action.name ?? action.xmlId, kind: 'serverAction' });
      edges.push({ from: catId, to: `action:${action.xmlId}` });
    }
  }

  const accessSuffix = `model_${modelName.replace(/\./g, '_')}`;
  const accessRows = index.accessRules.filter((r) => {
    const s = r.modelId.includes('.') ? r.modelId.split('.').pop()! : r.modelId;
    return s === accessSuffix;
  });
  const recordRules = index.ruleRecords.filter((r) => r.model === modelName);
  if (accessRows.length > 0 || recordRules.length > 0) {
    const catId = `cat:security:${modelName}`;
    addCategory(catId, `Security (${accessRows.length + recordRules.length})`);
    for (const row of accessRows) {
      nodes.push({ id: `access:${row.id}`, label: row.name || row.id, kind: 'accessRule' });
      edges.push({ from: catId, to: `access:${row.id}` });
    }
    for (const rule of recordRules) {
      nodes.push({ id: `rule:${rule.xmlId}`, label: rule.name ?? rule.xmlId, kind: 'recordRule' });
      edges.push({ from: catId, to: `rule:${rule.xmlId}` });
    }
  }

  return { nodes: dedupeNodes(nodes), edges, title: `Unified graph: ${modelName}` };
}

function dedupeNodes(nodes: GraphNode[]): GraphNode[] {
  const seen = new Map<string, GraphNode>();
  for (const n of nodes) if (!seen.has(n.id)) seen.set(n.id, n);
  return Array.from(seen.values());
}
