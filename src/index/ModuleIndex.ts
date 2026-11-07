import * as fs from 'fs';
import * as path from 'path';
import { OdooManifest } from '../semantic/OdooTypes';
import { parseManifest } from '../parser/manifest/ManifestParser';

export interface DiscoveredModule {
  manifest: OdooManifest;
}

const IGNORED_DIRS = new Set(['node_modules', '.git', '.vscode', 'out', 'dist', '__pycache__', '.tox', '.venv', 'venv']);

/** Recursively finds every directory containing a `__manifest__.py` or `__openerp__.py`. */
export function discoverManifestFiles(root: string, maxDepth = 8): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const manifestName of ['__manifest__.py', '__openerp__.py']) {
      if (entries.some((e) => e.isFile() && e.name === manifestName)) {
        found.push(path.join(dir, manifestName));
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        walk(path.join(dir, entry.name), depth + 1);
      }
    }
  };
  walk(root, 0);
  return found;
}

export async function loadModules(
  manifestFiles: string[],
  extensionRoot: string,
  readFile: (p: string) => string
): Promise<Map<string, OdooManifest>> {
  const modules = new Map<string, OdooManifest>();
  for (const file of manifestFiles) {
    try {
      const source = readFile(file);
      const manifest = await parseManifest(file, source, extensionRoot);
      if (manifest) modules.set(manifest.module, manifest);
    } catch {
      // Malformed manifest: skip gracefully, per graceful-degradation requirement.
    }
  }
  return modules;
}

/**
 * Topologically sorts modules by `depends`. Modules with unresolved external dependencies
 * (e.g. core Odoo modules not present in the workspace) are treated as already-satisfied
 * leaves so local modules still get a deterministic, dependency-respecting order.
 */
export function topologicalModuleOrder(modules: Map<string, OdooManifest>): string[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  const visit = (name: string) => {
    if (visited.has(name) || !modules.has(name)) return;
    if (visiting.has(name)) return; // cycle guard
    visiting.add(name);
    const manifest = modules.get(name)!;
    for (const dep of manifest.depends) {
      visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  };

  for (const name of modules.keys()) visit(name);
  return order;
}

export function reverseDependents(modules: Map<string, OdooManifest>, moduleName: string): string[] {
  const out: string[] = [];
  for (const [name, manifest] of modules) {
    if (manifest.depends.includes(moduleName)) out.push(name);
  }
  return out;
}
