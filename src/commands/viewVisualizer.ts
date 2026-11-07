import * as vscode from 'vscode';
import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { mergeViewChain } from '../parser/xml/ViewMerger';
import { XmlNodeRef, OdooViewRecord } from '../semantic/OdooTypes';
import { getNonce } from '../utils/nonce';

function childrenChain(index: OdooWorkspaceIndex, baseId: string): OdooViewRecord[] {
  const children = (id: string) =>
    Array.from(index.viewsById.values())
      .filter((v) => v.inheritId === id)
      .sort((a, b) => index.moduleOrder.indexOf(a.module) - index.moduleOrder.indexOf(b.module));
  const chain: OdooViewRecord[] = [];
  let frontier = children(baseId);
  const seen = new Set([baseId]);
  while (frontier.length > 0) {
    const next: OdooViewRecord[] = [];
    for (const v of frontier) {
      if (seen.has(v.xmlId)) continue;
      seen.add(v.xmlId);
      chain.push(v);
      next.push(...children(v.xmlId));
    }
    frontier = next;
  }
  return chain;
}

/** Walk inherit_id links upward until a root (no inherit) or a missing external base. */
function resolveRootView(index: OdooWorkspaceIndex, start: OdooViewRecord): OdooViewRecord {
  const seen = new Set<string>();
  let current = start;
  while (current.inheritId && !seen.has(current.xmlId)) {
    seen.add(current.xmlId);
    const parent = index.viewsById.get(current.inheritId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

function renderNode(node: XmlNodeRef, provenance: Map<XmlNodeRef, OdooViewRecord>, depth: number): string {
  const prov = provenance.get(node);
  const badge = prov ? ` <span class="badge" title="Introduced by ${prov.module}">${prov.module}</span>` : '';
  const attrs = Object.entries(node.attributes)
    .filter(([k]) => ['name', 'string', 'position'].includes(k))
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  const label = `&lt;${node.tag}${attrs ? ' ' + attrs : ''}&gt;`;
  const childrenHtml = node.children.map((c) => renderNode(c, provenance, depth + 1)).join('');
  const hasChildren = node.children.length > 0;
  return `<li>
    <span class="node-label" data-file="${node.location.file}" data-line="${node.location.startLine}">${label}${badge}</span>
    ${hasChildren ? `<ul>${childrenHtml}</ul>` : ''}
  </li>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * QuickPick that supports both selecting a listed view and typing a free-form XML ID
 * (Accept on a filtered empty list still uses the typed value).
 */
async function pickViewXmlId(index: OdooWorkspaceIndex): Promise<string | undefined> {
  const views = Array.from(index.viewsById.values()).sort((a, b) => a.xmlId.localeCompare(b.xmlId));

  type Item = vscode.QuickPickItem & { xmlId: string };
  const items: Item[] = views.map((v) => ({
    label: v.xmlId,
    xmlId: v.xmlId,
    description: [v.model, v.viewType, v.module, v.inheritId ? `inherits ${v.inheritId}` : 'base']
      .filter(Boolean)
      .join(' · '),
    detail: v.file,
  }));

  const qp = vscode.window.createQuickPick<Item>();
  qp.placeholder = views.length
    ? 'Select a view or type its XML ID (e.g. sale_studio.view_sale_order_form)'
    : 'No views indexed yet — type a view XML ID, or run “Odoo: Analyze Workspace” first';
  qp.items = items;
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.ignoreFocusOut = true;
  qp.canSelectMany = false;
  qp.title = 'OdooLens: Show View Inheritance';

  return new Promise((resolve) => {
    const disposables: vscode.Disposable[] = [];
    const finish = (value: string | undefined) => {
      disposables.forEach((d) => d.dispose());
      qp.hide();
      qp.dispose();
      resolve(value);
    };

    disposables.push(
      qp.onDidAccept(() => {
        const selected = qp.selectedItems[0];
        if (selected?.xmlId) {
          finish(selected.xmlId);
          return;
        }
        // User typed a value that may not be in the list (or filtered everything out).
        const typed = qp.value.trim();
        finish(typed || undefined);
      }),
      qp.onDidHide(() => finish(undefined))
    );

    qp.show();
  });
}

export function registerViewVisualizerCommand(context: vscode.ExtensionContext, index: OdooWorkspaceIndex): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('odooIntelligence.showViewInheritance', async () => {
      if (index.viewsById.size === 0) {
        const run = await vscode.window.showWarningMessage(
          'OdooLens: no views are indexed yet. Analyze the workspace first?',
          'Analyze Workspace'
        );
        if (run === 'Analyze Workspace') {
          await vscode.commands.executeCommand('odooIntelligence.analyzeWorkspace');
        }
        if (index.viewsById.size === 0) {
          // Still allow typing an ID in case index is partial
          const typed = await vscode.window.showInputBox({
            title: 'OdooLens: Show View Inheritance',
            prompt: 'Enter a view XML ID (module.id)',
            placeHolder: 'e.g. sale_studio.view_sale_order_form',
            ignoreFocusOut: true,
          });
          if (!typed) return;
          await openViewInheritance(index, typed.trim());
          return;
        }
      }

      const chosen = await pickViewXmlId(index);
      if (!chosen) return;
      await openViewInheritance(index, chosen);
    })
  );
}

async function openViewInheritance(index: OdooWorkspaceIndex, chosen: string): Promise<void> {
  let start = index.viewsById.get(chosen);
  if (!start) {
    // Try module-unqualified match
    const suffix = '.' + chosen;
    start = Array.from(index.viewsById.values()).find((v) => v.xmlId === chosen || v.xmlId.endsWith(suffix));
  }
  if (!start) {
    vscode.window.showErrorMessage(
      `OdooLens: view "${chosen}" was not found in the index. Run “Odoo: Analyze Workspace” or check the XML ID.`
    );
    return;
  }

  // Visualize from the resolved root when possible so inheritance chain is complete.
  const root = resolveRootView(index, start);
  const base = root.archNode ? root : start;
  if (!base.archNode) {
    vscode.window.showWarningMessage(
      `OdooLens: view "${base.xmlId}" has no arch in the index (external inherit target?). Open a workspace view that defines the arch.`
    );
    return;
  }

  const chain = childrenChain(index, base.xmlId);
  const { effectiveArch, issues, provenance } = mergeViewChain(base, chain);
  if (!effectiveArch) {
    vscode.window.showWarningMessage('OdooLens: could not build an effective arch for this view.');
    return;
  }

  const nonce = getNonce();
  const panel = vscode.window.createWebviewPanel(
    'odooViewInheritance',
    `View: ${base.xmlId}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true }
  );
  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === 'openSource') {
      vscode.workspace.openTextDocument(msg.file).then((doc) =>
        vscode.window.showTextDocument(doc, {
          selection: new vscode.Range(msg.line, 0, msg.line, 0),
        })
      );
    }
  });

  const issuesHtml = issues.length
    ? `<h3>⚠ ${issues.length} inheritance issue(s)</h3><ul>${issues
        .map((i) => `<li>${escapeHtml(i.message)} <i>(from ${i.view.module}/${i.view.xmlId})</i></li>`)
        .join('')}</ul>`
    : '<p>No unresolved xpath/position targets detected in this chain.</p>';

  const note =
    start.xmlId !== base.xmlId
      ? `<p class="hint">You selected <code>${escapeHtml(start.xmlId)}</code>; showing chain from root <code>${escapeHtml(base.xmlId)}</code>.</p>`
      : '';

  const csp = `default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  panel.webview.html = `<!doctype html><html><head>
        <meta http-equiv="Content-Security-Policy" content="${csp}">
        <style>
          body { font-family: var(--vscode-font-family); padding: 1em; color: var(--vscode-editor-foreground); }
          ul { list-style-type: none; }
          li { margin: 2px 0; }
          .node-label { cursor: pointer; font-family: var(--vscode-editor-font-family); }
          .node-label:hover { text-decoration: underline; }
          .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px; font-size: 10px; padding: 1px 5px; margin-left: 6px; }
          .hint { opacity: 0.8; font-size: 12px; }
          ol li { margin: 4px 0; }
          code { font-family: var(--vscode-editor-font-family); }
        </style>
      </head><body>
        <h2>${escapeHtml(base.xmlId)} <small>(merging ${chain.length} inheriting view(s))</small></h2>
        ${note}
        ${issuesHtml}
        <h3>Inheritance chain (modifications)</h3>
        <ol>
          <li><b>${escapeHtml(base.xmlId)}</b> (base)</li>
          ${chain
            .map(
              (v) =>
                `<li><span class="node-label" data-file="${v.file}" data-line="${v.location.startLine}"><b>${escapeHtml(v.xmlId)}</b></span> from module <code>${escapeHtml(v.module)}</code>${v.viewType ? ' [' + escapeHtml(v.viewType) + ']' : ''}</li>`
            )
            .join('')}
        </ol>
        <h3>Effective view tree</h3>
        <p class="hint">Click a node to open its source declaration.</p>
        <ul>${renderNode(effectiveArch, provenance, 0)}</ul>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          document.querySelectorAll('.node-label').forEach((el) => {
            el.addEventListener('click', () => {
              const file = el.getAttribute('data-file');
              const line = Number(el.getAttribute('data-line') || 0);
              if (file) vscode.postMessage({ type: 'openSource', file, line });
            });
          });
        </script>
      </body></html>`;
}
