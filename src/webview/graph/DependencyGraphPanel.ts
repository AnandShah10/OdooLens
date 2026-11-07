import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce';
import { GraphData } from './GraphBuilder';

export { GraphNode, GraphEdge, GraphData, buildModuleGraph, buildModelGraph, buildUnifiedModelGraph } from './GraphBuilder';

export class DependencyGraphPanel {
  static currentPanel: DependencyGraphPanel | undefined;
  private panel: vscode.WebviewPanel;

  private constructor(panel: vscode.WebviewPanel, private extensionUri: vscode.Uri) {
    this.panel = panel;
    this.panel.onDidDispose(() => (DependencyGraphPanel.currentPanel = undefined));
    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'openSource' && typeof msg.file === 'string') {
        vscode.workspace.openTextDocument(msg.file).then((doc) => vscode.window.showTextDocument(doc));
      }
    });
  }

  static show(extensionUri: vscode.Uri, data: GraphData, fileLookup: Record<string, string> = {}): void {
    if (DependencyGraphPanel.currentPanel) {
      DependencyGraphPanel.currentPanel.panel.reveal();
    } else {
      const panel = vscode.window.createWebviewPanel('odooDependencyGraph', 'OdooLens Dependency Graph', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      DependencyGraphPanel.currentPanel = new DependencyGraphPanel(panel, extensionUri);
    }
    DependencyGraphPanel.currentPanel.render(data, fileLookup);
  }

  private render(data: GraphData, fileLookup: Record<string, string>): void {
    const nonce = getNonce();
    this.panel.title = data.title;
    this.panel.webview.html = renderGraphHtml(this.panel.webview, nonce, data, fileLookup);
  }
}

function renderGraphHtml(webview: vscode.Webview, nonce: string, data: GraphData, fileLookup: Record<string, string>): string {
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { margin:0; font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
  #toolbar { padding: 6px 10px; display:flex; gap:8px; align-items:center; border-bottom: 1px solid var(--vscode-panel-border); }
  #toolbar input { flex:1; padding:4px; }
  svg { width:100vw; height: calc(100vh - 38px); cursor: grab; }
  .node circle { stroke: var(--vscode-focusBorder); stroke-width: 1.5px; }
  .node.module circle { fill: #3776ab55; }
  .node.model circle { fill: #71368a55; }
  .node.view circle { fill: #2a9d8f55; }
  .node.field circle { fill: #6c757d55; }
  .node.method circle { fill: #e67e2255; }
  .node.cron circle { fill: #8e44ad55; }
  .node.serverAction circle { fill: #d3547555; }
  .node.accessRule circle { fill: #c0392b55; }
  .node.recordRule circle { fill: #e74c3c55; }
  .node.category circle { fill: none; stroke-dasharray: 2,2; }
  .node.category text { font-weight: bold; }
  .node text { font-size: 11px; fill: var(--vscode-editor-foreground); pointer-events:none; }
  .node.dim { opacity: 0.15; }
  .edge { stroke: var(--vscode-panel-border); stroke-width: 1px; fill:none; }
  .edge.dim { opacity: 0.08; }
  .edge-label { font-size: 9px; fill: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div id="toolbar">
  <b>${escapeHtml(data.title)}</b>
  <input id="search" placeholder="Filter nodes…" />
</div>
<svg id="canvas"><g id="viewport"></g></svg>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const data = ${JSON.stringify(data)};
const fileLookup = ${JSON.stringify(fileLookup)};

const svg = document.getElementById('canvas');
const viewport = document.getElementById('viewport');
const W = window.innerWidth, H = window.innerHeight - 38;

// Simple deterministic radial/grid layout (no physics dependency): group by kind, arrange in rings.
const byKind = {};
data.nodes.forEach(n => { (byKind[n.kind] = byKind[n.kind] || []).push(n); });
const positions = {};
const kinds = Object.keys(byKind);
const centerX = W/2, centerY = H/2;
kinds.forEach((kind, ki) => {
  const nodes = byKind[kind];
  const radius = 80 + ki * 160;
  nodes.forEach((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2;
    positions[n.id] = { x: centerX + radius * Math.cos(angle), y: centerY + radius * Math.sin(angle) };
  });
});

function makeSvg(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

data.edges.forEach(e => {
  const a = positions[e.from], b = positions[e.to];
  if (!a || !b) return;
  const line = makeSvg('line', { x1:a.x, y1:a.y, x2:b.x, y2:b.y, class:'edge', 'data-from':e.from, 'data-to':e.to });
  viewport.appendChild(line);
  if (e.label) {
    const label = makeSvg('text', { x:(a.x+b.x)/2, y:(a.y+b.y)/2, class:'edge-label' });
    label.textContent = e.label;
    viewport.appendChild(label);
  }
});

data.nodes.forEach(n => {
  const p = positions[n.id];
  const g = makeSvg('g', { class: 'node ' + n.kind, 'data-id': n.id, transform: 'translate(' + p.x + ',' + p.y + ')' });
  const circle = makeSvg('circle', { r: n.kind === 'module' ? 10 : 7 });
  const text = makeSvg('text', { x: 12, y: 4 });
  text.textContent = n.label;
  g.appendChild(circle);
  g.appendChild(text);
  g.addEventListener('click', () => {
    const file = fileLookup[n.id];
    if (file) vscode.postMessage({ type: 'openSource', file });
    highlight(n.id);
  });
  viewport.appendChild(g);
});

function highlight(id) {
  const connected = new Set([id]);
  data.edges.forEach(e => { if (e.from === id) connected.add(e.to); if (e.to === id) connected.add(e.from); });
  document.querySelectorAll('.node').forEach(el => {
    el.classList.toggle('dim', !connected.has(el.getAttribute('data-id')));
  });
  document.querySelectorAll('.edge').forEach(el => {
    const from = el.getAttribute('data-from'), to = el.getAttribute('data-to');
    el.classList.toggle('dim', from !== id && to !== id);
  });
}

document.getElementById('search').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('.node').forEach(el => {
    const id = el.getAttribute('data-id').toLowerCase();
    el.classList.toggle('dim', q.length > 0 && !id.includes(q));
  });
});

// Pan and zoom.
let scale = 1, tx = 0, ty = 0, dragging = false, lastX = 0, lastY = 0;
function applyTransform() { viewport.setAttribute('transform', 'translate(' + tx + ',' + ty + ') scale(' + scale + ')'); }
svg.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; svg.style.cursor='grabbing'; });
window.addEventListener('mouseup', () => { dragging = false; svg.style.cursor='grab'; });
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  tx += e.clientX - lastX; ty += e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  applyTransform();
});
svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 1.1 : 0.9;
  scale = Math.min(4, Math.max(0.2, scale * delta));
  applyTransform();
}, { passive: false });
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
