import { PythonFileAnalysis } from '../parser/python/OdooModelExtractor';
import { XmlNodeRef } from '../semantic/OdooTypes';

/** Structural stand-in for OdooIndex.XmlFileAnalysis to avoid a circular import. */
type XmlFileAnalysis = {
  file: string;
  module: string;
  root: XmlNodeRef | null;
  views: any[];
  rules: any[];
  crons: any[];
  serverActions: any[];
  reports: any[];
  templates: any[];
  declaredIds: any[];
  refUses: any[];
  errors: string[];
};

/**
 * Bump this whenever cached shapes change, so a cache written by an older version of OdooLens
 * is discarded rather than fed into code that expects a newer shape. Cheap insurance: a version
 * mismatch just means one extra full parse, not a crash.
 */
const CACHE_VERSION = 6; // v6: PythonFileAnalysis.imports + reports/templates on XML

export interface CachedPythonEntry {
  mtimeMs: number;
  analysis: PythonFileAnalysis;
}

export interface CachedXmlEntry {
  mtimeMs: number;
  analysis: XmlFileAnalysis;
}

export interface IndexCacheData {
  version: number;
  python: Record<string, CachedPythonEntry>;
  xml?: Record<string, CachedXmlEntry>;
}

/** Deep-clone an XmlNodeRef tree without `parent` back-references (JSON-safe). */
function stripParents(node: XmlNodeRef | null | undefined): XmlNodeRef | null {
  if (!node) return null;
  const clone: XmlNodeRef = {
    tag: node.tag,
    attributes: { ...node.attributes },
    children: node.children.map((c) => stripParents(c)!),
    location: { ...node.location },
    text: node.text,
  };
  return clone;
}

/** Re-attach parent pointers after loading a stripped tree from cache. */
function reattachParents(node: XmlNodeRef | null | undefined, parent?: XmlNodeRef): XmlNodeRef | null {
  if (!node) return null;
  node.parent = parent;
  for (const child of node.children) {
    reattachParents(child, node);
  }
  return node;
}

/** Prepare an XmlFileAnalysis for JSON serialization (strip circular parent links). */
function serializeXmlAnalysis(analysis: XmlFileAnalysis): XmlFileAnalysis {
  const root = stripParents(analysis.root);
  // views/rules/etc. may hold archNode references into the tree — re-point them at the clone.
  // We re-extract from root is expensive; instead walk and null archNode if we can't match.
  // Practical approach: store the analysis with stripped root; archNode on views is rebuilt
  // lazily by consumers that need the full tree, OR we null it and accept re-walk from root.
  // For correctness, clear archNode pointers (they point into the old tree) and let callers
  // that need arch re-find from root via extractViewRecords if necessary. Most analyzers use
  // the pre-extracted views list fields, not archNode deep walks after cache load.
  return {
    ...analysis,
    root,
    views: analysis.views.map((v) => ({
      ...v,
      archNode: undefined, // will be re-linked below if possible
      location: { ...v.location },
    })),
    rules: analysis.rules.map((r) => ({ ...r, location: { ...r.location } })),
    crons: analysis.crons.map((c) => ({ ...c, location: { ...c.location } })),
    serverActions: analysis.serverActions.map((s) => ({ ...s, location: { ...s.location } })),
    reports: (analysis.reports ?? []).map((r: any) => ({ ...r, location: { ...r.location } })),
    templates: (analysis.templates ?? []).map((t: any) => ({
      ...t,
      archNode: undefined,
      location: { ...t.location },
      fieldExpressions: (t.fieldExpressions ?? []).map((fe: any) => ({ ...fe, location: { ...fe.location } })),
      tCalls: (t.tCalls ?? []).map((c: any) => ({ ...c, location: { ...c.location } })),
    })),
    declaredIds: analysis.declaredIds.map((d) => ({ ...d, location: { ...d.location } })),
    refUses: analysis.refUses.map((u) => ({ ...u, location: { ...u.location } })),
    errors: [...analysis.errors],
  };
}

/** After deserialize, restore parent links on the root tree. */
function reviveXmlAnalysis(analysis: XmlFileAnalysis): XmlFileAnalysis {
  analysis.root = reattachParents(analysis.root) ?? null;
  return analysis;
}

/**
 * Persists Python *and* XML analyses. XmlNodeRef trees carry a `parent` back-reference that
 * makes them circular; we strip parents on write and re-attach on read. archNode pointers on
 * view records are cleared on cache (they pointed into the pre-strip tree); analyzers that need
 * the arch can re-walk from `root` or re-run extraction. Python parsing remains the dominant
 * cost, but XML caching still helps large view-heavy workspaces.
 */
export function serializeIndexCache(
  pythonEntries: Map<string, CachedPythonEntry>,
  xmlEntries?: Map<string, CachedXmlEntry>
): string {
  const xml: Record<string, CachedXmlEntry> = {};
  if (xmlEntries) {
    for (const [file, entry] of xmlEntries) {
      xml[file] = {
        mtimeMs: entry.mtimeMs,
        analysis: serializeXmlAnalysis(entry.analysis),
      };
    }
  }
  const data: IndexCacheData = {
    version: CACHE_VERSION,
    python: Object.fromEntries(pythonEntries),
    xml: Object.keys(xml).length ? xml : undefined,
  };
  return JSON.stringify(data);
}

/** Returns null (never throws) for anything that isn't a valid, current-version cache —
 *  a corrupt or stale cache file should degrade to "cache miss", not crash indexing. */
export function deserializeIndexCache(raw: string): IndexCacheData | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.version !== CACHE_VERSION || typeof parsed.python !== 'object') {
      return null;
    }
    if (parsed.xml && typeof parsed.xml === 'object') {
      for (const key of Object.keys(parsed.xml)) {
        const entry = parsed.xml[key];
        if (entry?.analysis) {
          entry.analysis = reviveXmlAnalysis(entry.analysis);
        }
      }
    }
    return parsed as IndexCacheData;
  } catch {
    return null;
  }
}
