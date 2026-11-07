import * as vscode from 'vscode';
import { TreeNode } from './TreeData';

const ICONS: Record<TreeNode['kind'], string> = {
  model: 'symbol-class',
  module: 'package',
  category: 'folder',
  field: 'symbol-field',
  method: 'symbol-method',
  'problem-category': 'warning',
  problem: 'circle-small-filled',
};

export const OPEN_LOCATION_COMMAND = 'odooIntelligence.openLocation';

/**
 * The thin `vscode` layer over `TreeData.ts`'s pure tree builders. One class serves all three
 * explorers (Models / Modules / Problems): each instance is given a function that produces its
 * root nodes from current index/diagnostic state, so a refresh simply re-runs that function —
 * there's no separate per-explorer caching to keep in sync with the index.
 */
export class ExplorerProvider implements vscode.TreeDataProvider<TreeNode> {
  private changeEmitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private roots: TreeNode[] = [];

  constructor(private buildRoots: () => TreeNode[]) {
    this.roots = buildRoots();
  }

  refresh(): void {
    this.roots = this.buildRoots();
    this.changeEmitter.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const collapsible = node.children && node.children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, collapsible);
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.iconPath = new vscode.ThemeIcon(ICONS[node.kind]);
    item.contextValue = node.kind;
    if (node.location) {
      item.command = { command: OPEN_LOCATION_COMMAND, title: 'Open source', arguments: [node.location] };
    }
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    return node ? node.children ?? [] : this.roots;
  }
}

/** Opens a file at a location and reveals it — the single click handler for every tree node
 *  that carries a `location`. Registered once in extension.ts. */
export async function openLocation(location: { file: string; startLine: number; startCol: number; endLine: number; endCol: number }): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(location.file);
  const range = new vscode.Range(location.startLine, location.startCol, location.endLine, location.endCol);
  const editor = await vscode.window.showTextDocument(doc, { selection: range });
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}
