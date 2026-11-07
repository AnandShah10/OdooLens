import * as path from 'path';
import { parsePython } from '../python/TreeSitterPython';
import { evalLiteral, findAll, loc } from '../python/AstUtils';
import { OdooManifest, normalizeInherit } from '../../semantic/OdooTypes';

/**
 * Parses an Odoo `__manifest__.py` (or legacy `__openerp__.py`) file, which is a bare
 * Python dict literal (occasionally with a leading `{...}` expression statement).
 * We evaluate it as a literal via the shared AST literal evaluator rather than `eval()`,
 * so malformed or dynamic manifests degrade gracefully instead of executing arbitrary code.
 */
export async function parseManifest(
  filePath: string,
  source: string,
  extensionRoot: string
): Promise<OdooManifest | null> {
  const { tree } = await parsePython(source, extensionRoot);
  const dictNodes = findAll(tree.rootNode, 'dictionary');
  if (dictNodes.length === 0) return null;
  // The manifest's top-level dict is the first dictionary literal at module scope.
  const topLevel = dictNodes.find((n) => {
    let p = n.parent;
    while (p && p.type !== 'module') {
      if (p.type === 'dictionary' || p.type === 'function_definition' || p.type === 'class_definition') return false;
      p = p.parent;
    }
    return true;
  }) ?? dictNodes[0];

  const raw = (evalLiteral(topLevel) as Record<string, unknown>) ?? {};
  const moduleDir = path.dirname(filePath);
  const moduleName = path.basename(moduleDir);

  return {
    module: moduleName,
    dir: moduleDir,
    depends: normalizeInherit(raw['depends']),
    data: Array.isArray(raw['data']) ? (raw['data'] as unknown[]).filter((v): v is string => typeof v === 'string') : [],
    installable: raw['installable'] === undefined ? true : Boolean(raw['installable']),
    auto_install: Boolean(raw['auto_install']),
    version: typeof raw['version'] === 'string' ? (raw['version'] as string) : undefined,
    application: Boolean(raw['application']),
    raw,
    location: loc(topLevel, filePath),
  };
}
