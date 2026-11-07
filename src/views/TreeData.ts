import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { OdooDiagnostic, SourceLocation } from '../semantic/OdooTypes';

/**
 * A generic, framework-independent tree node shared by all three sidebar explorers. Kept
 * separate from `vscode.TreeItem` (like `webview/graph/GraphBuilder.ts` is kept separate from
 * `DependencyGraphPanel.ts`) so the actual tree-construction LOGIC is unit-testable without a
 * VS Code host — only the thin `vscode.TreeDataProvider` wrappers in this folder's other files
 * need the real `vscode` module.
 */
export interface TreeNode {
  id: string;
  label: string;
  description?: string;
  /** Used by the vscode-side wrapper to pick an icon/context value; purely descriptive here. */
  kind: 'model' | 'module' | 'category' | 'field' | 'method' | 'problem-category' | 'problem';
  /** When set, clicking this node should open and reveal this location. */
  location?: SourceLocation;
  /** Extra detail shown only in a tooltip, not the label/description (kept short on purpose). */
  tooltip?: string;
  children?: TreeNode[];
}

function categoryNode(id: string, label: string, kind: TreeNode['kind'], children: TreeNode[]): TreeNode | null {
  if (children.length === 0) return null;
  return { id, label: `${label} (${children.length})`, kind, children };
}

/** One root node per indexed model, alphabetically sorted, each expandable into Fields/Methods. */
export function buildModelTreeRoots(index: OdooWorkspaceIndex): TreeNode[] {
  const modelNames = Array.from(index.models.keys()).sort();
  const roots: TreeNode[] = [];

  for (const name of modelNames) {
    const model = index.models.get(name)!;
    const primaryLocation = model.contributions[0]?.location;

    const fieldNodes: TreeNode[] = Array.from(model.fields.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({
        id: `field:${name}.${f.name}`,
        label: f.name,
        description: f.fieldType + (f.comodel ? ` → ${f.comodel}` : ''),
        kind: 'field' as const,
        location: f.location,
        tooltip: f.compute ? `Computed by ${f.compute}` : undefined,
      }));

    const methodNodes: TreeNode[] = Array.from(model.methods.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => ({
        id: `method:${name}.${m.name}`,
        label: `${m.name}()`,
        description: m.decorators.length ? m.decorators.map((d) => '@' + d.name).join(', ') : undefined,
        kind: 'method' as const,
        location: m.location,
      }));

    const children: TreeNode[] = [];
    const fieldsCategory = categoryNode(`cat:fields:${name}`, 'Fields', 'category', fieldNodes);
    if (fieldsCategory) children.push(fieldsCategory);
    const methodsCategory = categoryNode(`cat:methods:${name}`, 'Methods', 'category', methodNodes);
    if (methodsCategory) children.push(methodsCategory);

    roots.push({
      id: `model:${name}`,
      label: name,
      description: `${model.fields.size} field(s), ${model.methods.size} method(s)`,
      kind: 'model',
      location: primaryLocation,
      tooltip: `Declared in: ${Array.from(model.modules).join(', ')}`,
      children: children.length > 0 ? children : undefined,
    });
  }

  return roots;
}

/** One root node per module, in dependency order, each expandable into the models it
 *  contributes to and the modules it depends on. */
export function buildModuleTreeRoots(index: OdooWorkspaceIndex): TreeNode[] {
  const roots: TreeNode[] = [];

  for (const moduleName of index.moduleOrder) {
    const manifest = index.modules.get(moduleName);
    if (!manifest) continue;

    const contributedModels: TreeNode[] = Array.from(index.models.entries())
      .filter(([, model]) => model.modules.has(moduleName))
      .map(([name, model]) => ({
        id: `module:${moduleName}:model:${name}`,
        label: name,
        kind: 'model' as const,
        location: model.contributions.find((c) => c.module === moduleName)?.location,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const dependsOn: TreeNode[] = manifest.depends
      .map((dep) => ({
        id: `module:${moduleName}:depends:${dep}`,
        label: dep,
        kind: 'module' as const,
        location: index.modules.get(dep)?.location,
        description: index.modules.has(dep) ? undefined : '(not in workspace)',
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const children: TreeNode[] = [];
    const modelsCategory = categoryNode(`cat:models:${moduleName}`, 'Models', 'category', contributedModels);
    if (modelsCategory) children.push(modelsCategory);
    const dependsCategory = categoryNode(`cat:depends:${moduleName}`, 'Depends on', 'category', dependsOn);
    if (dependsCategory) children.push(dependsCategory);

    roots.push({
      id: `module:${moduleName}`,
      label: moduleName,
      description: `${manifest.depends.length} dep(s)`,
      kind: 'module',
      location: manifest.location,
      children: children.length > 0 ? children : undefined,
    });
  }

  return roots;
}

const CATEGORY_ORDER: OdooDiagnostic['category'][] = ['security', 'performance', 'deadCode', 'xml', 'migration', 'general'];
const CATEGORY_LABELS: Record<OdooDiagnostic['category'], string> = {
  security: 'Security',
  performance: 'Performance',
  deadCode: 'Dead Code',
  xml: 'XML',
  migration: 'Migration',
  general: 'General',
};

/** Groups the currently-published diagnostics by category (security first — highest-stakes
 *  findings surface at the top rather than being buried alphabetically or by file). */
export function buildProblemsTreeRoots(diagnostics: OdooDiagnostic[]): TreeNode[] {
  const byCategory = new Map<OdooDiagnostic['category'], OdooDiagnostic[]>();
  for (const d of diagnostics) {
    const arr = byCategory.get(d.category) ?? [];
    arr.push(d);
    byCategory.set(d.category, arr);
  }

  const roots: TreeNode[] = [];
  for (const category of CATEGORY_ORDER) {
    const items = byCategory.get(category);
    if (!items || items.length === 0) continue;

    const sorted = [...items].sort((a, b) => a.location.file.localeCompare(b.location.file) || a.location.startLine - b.location.startLine);
    const problemNodes: TreeNode[] = sorted.map((d, i) => ({
      id: `problem:${category}:${i}:${d.ruleId}`,
      label: d.ruleId,
      description: `${shortFileName(d.location.file)}:${d.location.startLine + 1}`,
      kind: 'problem' as const,
      location: d.location,
      tooltip: `${d.message} [${d.confidence} confidence]`,
    }));

    roots.push({
      id: `problem-category:${category}`,
      label: `${CATEGORY_LABELS[category]} (${items.length})`,
      kind: 'problem-category',
      children: problemNodes,
    });
  }
  return roots;
}

function shortFileName(file: string): string {
  const parts = file.split(/[/\\]/);
  return parts.slice(-2).join('/');
}
