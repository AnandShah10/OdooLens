import * as fs from 'fs';
import * as path from 'path';
import { OdooManifest, OdooModel, OdooViewRecord, OdooRuleRecord, OdooCronRecord, OdooServerActionRecord, OdooReportRecord, OdooTemplateRecord, XmlNodeRef } from '../semantic/OdooTypes';
import { discoverManifestFiles, loadModules, topologicalModuleOrder, reverseDependents } from './ModuleIndex';
import { buildModelIndex } from './ModelIndex';
import { ReferenceIndex } from './ReferenceIndex';
import { resolveAttributeChain } from './AttributeChainResolver';
import { extractOdooModels, PythonFileAnalysis } from '../parser/python/OdooModelExtractor';
import { extractOdooModelsMaybeWorker } from '../parser/python/ParseWorkerPool';
import { parseXml } from '../parser/xml/XmlParser';
import { findDescendants } from '../parser/xml/XmlParser';
import { extractViewRecords } from '../parser/xml/ViewExtractor';
import { extractRuleRecords } from '../parser/xml/RuleExtractor';
import { extractCronRecords, extractServerActionRecords } from '../parser/xml/AutomationRecordExtractor';
import { DeclaredXmlId, XmlRefUse, extractDeclaredIds, extractRefUses } from '../parser/xml/XmlIdExtractor';
import { extractReportRecords } from '../parser/xml/ReportExtractor';
import { extractTemplateRecords } from '../parser/xml/TemplateExtractor';
import { CachedPythonEntry, CachedXmlEntry, deserializeIndexCache, serializeIndexCache } from './IndexCache';
import { parseAccessCsv, AccessRuleRow } from '../parser/manifest/SecurityCsvParser';

export interface XmlFileAnalysis {
  file: string;
  module: string;
  root: XmlNodeRef | null;
  views: OdooViewRecord[];
  rules: OdooRuleRecord[];
  crons: OdooCronRecord[];
  serverActions: OdooServerActionRecord[];
  reports: OdooReportRecord[];
  templates: OdooTemplateRecord[];
  /** Every external id this file declares (record/menuitem/template/...), module-qualified. */
  declaredIds: DeclaredXmlId[];
  /** Every reference this file makes to another record's external id. */
  refUses: XmlRefUse[];
  errors: string[];
}

export interface IndexStats {
  moduleCount: number;
  pythonFileCount: number;
  xmlFileCount: number;
  modelCount: number;
  parseErrorCount: number;
  buildTimeMs: number;
  /** How many Python files were served from the persistent cache instead of re-parsed. 0 when
   *  `cacheFilePath` isn't set, or on a cold cache (first build / cache invalidated). */
  /** Total cache hits (Python + XML). */
  cacheHitCount: number;
  /** Python-only cache hits (stable metric for tests / progress). */
  pythonCacheHitCount: number;
  /** XML-only cache hits. */
  xmlCacheHitCount: number;
  /** True when the build stopped early because the caller's `isCancelled()` returned true. The
   *  index is still internally consistent (models are merged from whatever WAS parsed) but
   *  incomplete — modules/files not reached are simply absent until the next full build. */
  cancelled: boolean;
}

/** How many files to process between cooperative yields to the event loop. Tree-sitter parsing
 *  is synchronous, so without periodic yields a large rebuild blocks the extension host (and a
 *  cancel request could never even be observed). Small enough to stay responsive, large enough
 *  that the yield overhead is negligible. */
const YIELD_EVERY_N_FILES = 25;
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Max concurrent parse jobs. Tree-sitter WASM is process-global and not worker-friendly in the
 *  VS Code extension host, so we keep parsing on the main thread but overlap I/O + extraction
 *  across files with a small concurrency limit. Cancellation is still polled between batches. */
const PARSE_CONCURRENCY = 4;

/** Run async work over `items` with at most `limit` in flight; invokes `onItem` in order of
 *  completion. Stops scheduling new work once `shouldStop` returns true. */
async function mapPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  shouldStop: () => boolean
): Promise<void> {
  let idx = 0;
  const runNext = async (): Promise<void> => {
    while (idx < items.length) {
      if (shouldStop()) return;
      const current = items[idx++];
      await worker(current);
    }
  };
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(runners);
}

export interface BuildOptions {
  /** Polled between files; return true to stop early (see `IndexStats.cancelled`). */
  isCancelled?: () => boolean;
}

/** File-reading abstraction so the index is testable without a real filesystem/VS Code. */
export interface FileSystemAdapter {
  readFile(p: string): string;
  listFilesRecursive(dir: string, extensions: string[]): string[];
  /** Last-modified time in epoch milliseconds, or null if the file can't be stat'd (e.g. it was
   *  deleted between discovery and this call). Used by the persistent index cache to decide
   *  whether a cached analysis is still fresh. */
  statMtime(p: string): number | null;
  /** Writes a file, creating parent directories as needed. Used only by the persistent index
   *  cache; a failure here (e.g. read-only filesystem) should never fail indexing itself, so
   *  callers wrap this in try/catch rather than relying on it to throw cleanly. */
  writeFile(p: string, content: string): void;
}

export class NodeFsAdapter implements FileSystemAdapter {
  readFile(p: string): string {
    return fs.readFileSync(p, 'utf8');
  }
  statMtime(p: string): number | null {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return null;
    }
  }
  writeFile(p: string, content: string): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  listFilesRecursive(dir: string, extensions: string[]): string[] {
    const out: string[] = [];
    const IGNORED = new Set(['node_modules', '.git', '__pycache__', '.tox', '.venv', 'venv', 'out', 'dist']);
    const walk = (d: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || IGNORED.has(e.name)) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (extensions.some((ext) => e.name.endsWith(ext))) out.push(full);
      }
    };
    walk(dir);
    return out;
  }
}

export class OdooWorkspaceIndex {
  modules = new Map<string, OdooManifest>();
  moduleOrder: string[] = [];
  pythonFiles = new Map<string, PythonFileAnalysis>();
  xmlFiles = new Map<string, XmlFileAnalysis>();
  accessRules: AccessRuleRow[] = [];
  ruleRecords: OdooRuleRecord[] = [];
  cronRecords: OdooCronRecord[] = [];
  serverActionRecords: OdooServerActionRecord[] = [];
  reportRecords: OdooReportRecord[] = [];
  templateRecords: OdooTemplateRecord[] = [];
  models = new Map<string, OdooModel>();
  references = new ReferenceIndex();
  viewsById = new Map<string, OdooViewRecord>();
  lastBuildStats: IndexStats | null = null;

  /** When set, `buildFull()` persists Python analyses here across sessions (keyed by file path
   *  + mtime) so re-opening a large workspace doesn't re-parse every file from scratch — see
   *  IndexCache.ts for exactly what is and isn't cached. */
  cacheFilePath: string | null = null;
  private cacheHitCount = 0;
  private pythonCacheHitCount = 0;
  private xmlCacheHitCount = 0;

  constructor(private extensionRoot: string, private fsAdapter: FileSystemAdapter = new NodeFsAdapter()) {}

  /** Full workspace scan. Safe to call repeatedly ("Odoo: Rebuild Index"). */
  async buildFull(roots: string[], options: BuildOptions = {}): Promise<IndexStats> {
    const start = Date.now();
    this.modules.clear();
    this.pythonFiles.clear();
    this.xmlFiles.clear();
    this.accessRules = [];
    this.ruleRecords = [];
    this.cronRecords = [];
    this.serverActionRecords = [];
    this.reportRecords = [];
    this.templateRecords = [];
    this.models.clear();
    this.references.clear();
    this.viewsById.clear();

    let manifestFiles: string[] = [];
    for (const root of roots) manifestFiles.push(...discoverManifestFiles(root));
    manifestFiles = Array.from(new Set(manifestFiles));

    this.modules = await loadModules(manifestFiles, this.extensionRoot, (p) => this.fsAdapter.readFile(p));
    this.moduleOrder = topologicalModuleOrder(this.modules);

    let parseErrorCount = 0;
    this.cacheHitCount = 0;
    this.pythonCacheHitCount = 0;
    this.xmlCacheHitCount = 0;
    let cancelled = false;
    let filesSinceYield = 0;
    // Called between files: yields periodically and polls cancellation. Returns true if the
    // build should stop now.
    const checkpoint = async (): Promise<boolean> => {
      if (++filesSinceYield >= YIELD_EVERY_N_FILES) {
        filesSinceYield = 0;
        await yieldToEventLoop();
      }
      if (!cancelled && options.isCancelled?.()) cancelled = true;
      return cancelled;
    };
    const previousCache = this.loadCache();
    const nextPythonCache = new Map<string, CachedPythonEntry>();
    const nextXmlCache = new Map<string, CachedXmlEntry>();

    for (const moduleName of this.moduleOrder) {
      if (cancelled) break;
      const manifest = this.modules.get(moduleName)!;
      const pyFiles = this.fsAdapter
        .listFilesRecursive(manifest.dir, ['.py'])
        .filter((f) => !f.endsWith('__manifest__.py') && !f.endsWith('__openerp__.py'));
      await mapPool(
        pyFiles,
        PARSE_CONCURRENCY,
        async (file) => {
          if (await checkpoint()) return;
          const mtimeMs = this.fsAdapter.statMtime(file);
          const cached = previousCache?.python[file];
          let analysis: PythonFileAnalysis;
          if (mtimeMs !== null && cached && cached.mtimeMs === mtimeMs) {
            analysis = cached.analysis;
            this.cacheHitCount++;
            this.pythonCacheHitCount++;
          } else {
            let source: string;
            try {
              source = this.fsAdapter.readFile(file);
            } catch {
              return;
            }
            analysis = await extractOdooModelsMaybeWorker(file, source, moduleName, this.extensionRoot);
            if (analysis.parseError) parseErrorCount++;
          }
          this.pythonFiles.set(file, analysis);
          if (mtimeMs !== null) nextPythonCache.set(file, { mtimeMs, analysis });
        },
        () => cancelled
      );

      const xmlFiles = this.fsAdapter.listFilesRecursive(manifest.dir, ['.xml']);
      await mapPool(
        xmlFiles,
        PARSE_CONCURRENCY,
        async (file) => {
          if (await checkpoint()) return;
          const mtimeMs = this.fsAdapter.statMtime(file);
          const cachedXml = previousCache?.xml?.[file];
          let xmlAnalysis: XmlFileAnalysis;
          if (mtimeMs !== null && cachedXml && cachedXml.mtimeMs === mtimeMs) {
            // Normalize optional fields that older cache shapes / structural types may omit.
            const cached = cachedXml.analysis;
            xmlAnalysis = {
              ...cached,
              reports: cached.reports ?? [],
              templates: cached.templates ?? [],
            };
            this.cacheHitCount++;
            this.xmlCacheHitCount++;
          } else {
            let source: string;
            try {
              source = this.fsAdapter.readFile(file);
            } catch {
              return;
            }
            const { root, errors } = parseXml(file, source);
            const views = root ? extractViewRecords(root, moduleName, file) : [];
            const rules = root ? extractRuleRecords(root, moduleName, file) : [];
            const crons = root ? extractCronRecords(root, moduleName, file) : [];
            const serverActions = root ? extractServerActionRecords(root, moduleName, file) : [];
            const declaredIds = root ? extractDeclaredIds(root, moduleName, file) : [];
            const refUses = root ? extractRefUses(root, moduleName) : [];
            const reports = root ? extractReportRecords(root, moduleName, file) : [];
            const templates = root ? extractTemplateRecords(root, moduleName, file) : [];
            xmlAnalysis = { file, module: moduleName, root, views, rules, crons, serverActions, reports, templates, declaredIds, refUses, errors };
            if (errors.length) parseErrorCount += errors.length;
          }
          for (const v of xmlAnalysis.views) this.viewsById.set(v.xmlId, v);
          this.ruleRecords.push(...xmlAnalysis.rules);
          this.cronRecords.push(...xmlAnalysis.crons);
          this.serverActionRecords.push(...xmlAnalysis.serverActions);
          this.reportRecords.push(...(xmlAnalysis.reports ?? []));
          this.templateRecords.push(...(xmlAnalysis.templates ?? []));
          this.xmlFiles.set(file, xmlAnalysis);
          if (mtimeMs !== null) nextXmlCache.set(file, { mtimeMs, analysis: xmlAnalysis });
        },
        () => cancelled
      );

      const csvFiles = this.fsAdapter
        .listFilesRecursive(manifest.dir, ['.csv'])
        .filter((f) => f.endsWith('ir.model.access.csv'));
      for (const file of csvFiles) {
        try {
          const source = this.fsAdapter.readFile(file);
          this.accessRules.push(...parseAccessCsv(file, source));
        } catch {
          // Skip malformed CSV.
        }
      }
    }

    // Build merged model index in dependency order.
    const orderedContributions = this.moduleOrder.flatMap((moduleName) => {
      const contributions = [];
      for (const analysis of this.pythonFiles.values()) {
        if (analysis.file && this.belongsToModule(analysis.file, moduleName)) {
          contributions.push(...analysis.modelContributions);
        }
      }
      return contributions;
    });
    this.models = buildModelIndex(orderedContributions);

    this.buildReferenceIndex();
    if (cancelled && previousCache) {
      // Carry over cache entries for files we never got to, so cancelling a cold build doesn't
      // throw away the previous session's work. Stale entries are harmless: they're only ever
      // used when the file's current mtime still matches.
      for (const [file, entry] of Object.entries(previousCache.python)) {
        if (!nextPythonCache.has(file)) nextPythonCache.set(file, entry);
      }
      if (previousCache.xml) {
        for (const [file, entry] of Object.entries(previousCache.xml)) {
          if (!nextXmlCache.has(file)) nextXmlCache.set(file, entry);
        }
      }
    }
    this.saveCache(nextPythonCache, nextXmlCache);

    this.lastBuildStats = {
      moduleCount: this.modules.size,
      pythonFileCount: this.pythonFiles.size,
      xmlFileCount: this.xmlFiles.size,
      modelCount: this.models.size,
      parseErrorCount,
      buildTimeMs: Date.now() - start,
      cacheHitCount: this.cacheHitCount,
      pythonCacheHitCount: this.pythonCacheHitCount,
      xmlCacheHitCount: this.xmlCacheHitCount,
      cancelled,
    };
    return this.lastBuildStats;
  }

  private loadCache(): { python: Record<string, CachedPythonEntry>; xml?: Record<string, CachedXmlEntry> } | null {
    if (!this.cacheFilePath) return null;
    try {
      const raw = this.fsAdapter.readFile(this.cacheFilePath);
      return deserializeIndexCache(raw);
    } catch {
      return null; // No cache file yet, or unreadable — treat as a cold cache, not an error.
    }
  }

  private saveCache(pythonEntries: Map<string, CachedPythonEntry>, xmlEntries?: Map<string, CachedXmlEntry>): void {
    if (!this.cacheFilePath) return;
    try {
      this.fsAdapter.writeFile(this.cacheFilePath, serializeIndexCache(pythonEntries, xmlEntries));
    } catch {
      // A failed cache write (read-only FS, disk full, ...) must never fail indexing itself —
      // the next build just won't benefit from a cache, which is a performance miss, not a bug.
    }
  }

  /** Re-analyzes a single Python or XML file and refreshes derived indices. Debounce upstream. */
  async updateFile(file: string, moduleName: string): Promise<void> {
    const previousAnalysis = this.pythonFiles.get(file);
    const previousModels = new Set<string>();
    if (previousAnalysis) {
      for (const c of previousAnalysis.modelContributions) {
        const m = c.name ?? c.inherit[0];
        if (m) previousModels.add(m);
        for (const extra of c.inherit) previousModels.add(extra);
      }
    }

    if (file.endsWith('.py')) {
      if (file.endsWith('__manifest__.py')) return; // manifest changes require a full rebuild
      const source = this.fsAdapter.readFile(file);
      const analysis = await extractOdooModelsMaybeWorker(file, source, moduleName, this.extensionRoot);
      this.pythonFiles.set(file, analysis);

      const affectedModels = new Set(previousModels);
      for (const c of analysis.modelContributions) {
        const m = c.name ?? c.inherit[0];
        if (m) affectedModels.add(m);
        for (const extra of c.inherit) affectedModels.add(extra);
      }
      this.incrementalRebuildModels(affectedModels);
      this.buildReferenceIndex(affectedModels);
      return;
    } else if (file.endsWith('.xml')) {
      const previousXml = this.xmlFiles.get(file);
      const affectedModels = new Set<string>();
      for (const v of previousXml?.views ?? []) if (v.model) affectedModels.add(v.model);

      // Drop this file's previous contributions to the flat rule/cron/serverAction lists before
      // re-adding — otherwise repeated edits would duplicate entries indefinitely.
      this.ruleRecords = this.ruleRecords.filter((r) => r.file !== file);
      this.cronRecords = this.cronRecords.filter((r) => r.file !== file);
      this.serverActionRecords = this.serverActionRecords.filter((r) => r.file !== file);
      this.reportRecords = this.reportRecords.filter((r) => r.file !== file);
      this.templateRecords = this.templateRecords.filter((r) => r.file !== file);

      const source = this.fsAdapter.readFile(file);
      const { root, errors } = parseXml(file, source);
      const views = root ? extractViewRecords(root, moduleName, file) : [];
      const rules = root ? extractRuleRecords(root, moduleName, file) : [];
      const crons = root ? extractCronRecords(root, moduleName, file) : [];
      const serverActions = root ? extractServerActionRecords(root, moduleName, file) : [];
      const reports = root ? extractReportRecords(root, moduleName, file) : [];
      const templates = root ? extractTemplateRecords(root, moduleName, file) : [];
      const declaredIds = root ? extractDeclaredIds(root, moduleName, file) : [];
      const refUses = root ? extractRefUses(root, moduleName) : [];
      for (const v of views) {
        this.viewsById.set(v.xmlId, v);
        if (v.model) affectedModels.add(v.model);
      }
      this.ruleRecords.push(...rules);
      this.cronRecords.push(...crons);
      this.serverActionRecords.push(...serverActions);
      this.reportRecords.push(...reports);
      this.templateRecords.push(...templates);
      this.xmlFiles.set(file, { file, module: moduleName, root, views, rules, crons, serverActions, reports, templates, declaredIds, refUses, errors });
      this.buildReferenceIndex(affectedModels);
      return;
    }
    this.buildReferenceIndex();
  }

  /**
   * Recomputes ONLY the given models' merged view, by filtering the workspace's full
   * contribution list down to contributions targeting those models (still processed in
   * module-dependency order, so `_inherit` override ordering stays correct), then splicing the
   * result back into `this.models`. This is the "true incremental" path referenced in
   * ARCHITECTURE.md: unlike the naive approach of re-running `buildModelIndex()` over every
   * contribution in the workspace on every keystroke, a change to one file only pays the cost
   * of the (usually small) set of models it actually contributes to — a workspace with 500
   * unrelated models does not get 500x more expensive to re-index after editing one file.
   */
  private incrementalRebuildModels(affectedModels: Set<string>): void {
    if (affectedModels.size === 0) return;
    const relevantContributions = this.moduleOrder.flatMap((m) => {
      const out = [];
      for (const analysis of this.pythonFiles.values()) {
        if (!this.belongsToModule(analysis.file, m)) continue;
        for (const c of analysis.modelContributions) {
          const primary = c.name ?? c.inherit[0];
          const touchesAffected = (primary && affectedModels.has(primary)) || c.inherit.some((x) => affectedModels.has(x));
          if (touchesAffected) out.push(c);
        }
      }
      return out;
    });
    const rebuilt = buildModelIndex(relevantContributions);
    for (const name of affectedModels) {
      if (rebuilt.has(name)) this.models.set(name, rebuilt.get(name)!);
      else this.models.delete(name); // e.g. the model's last contribution was just deleted.
    }
  }

  private belongsToModule(file: string, moduleName: string): boolean {
    const manifest = this.modules.get(moduleName);
    if (!manifest) return false;
    return file.startsWith(manifest.dir + path.sep) || file === manifest.dir;
  }

  moduleOf(file: string): string | undefined {
    for (const [name, manifest] of this.modules) {
      if (file.startsWith(manifest.dir + path.sep)) return name;
    }
    return undefined;
  }

  private buildReferenceIndex(onlyModels?: Set<string>): void {
    if (onlyModels) {
      for (const m of onlyModels) this.references.clearModel(m);
    } else {
      this.references.clear();
    }
    const inScope = (model: string | undefined): boolean => !model || !onlyModels || onlyModels.has(model);

    // XML usages: <field name="x"/> inside a view whose `model` is known.
    for (const xmlFile of this.xmlFiles.values()) {
      for (const view of xmlFile.views) {
        if (!view.model || !view.archNode || !inScope(view.model)) continue;
        const fieldNodes = findDescendants(view.archNode, 'field');
        for (const fn of fieldNodes) {
          const name = fn.attributes.name;
          if (!name) continue;
          this.references.addFieldUsage(view.model, name, { location: fn.location, kind: 'xml-field' });
        }
      }
    }

    // Python usages: attribute access text scan over each file's raw source is avoided (would
    // require re-walking ASTs); instead we approximate using the model contributions we already
    // extracted, recording every field a model's own methods/fields reference via `dependsOn`,
    // plus every ORM call's target model as a model-level usage.
    //
    // For @api.depends / related paths we prefer the exact string-content location captured on
    // the decorator arg or related= kwarg so rename can rewrite the path safely.
    for (const analysis of this.pythonFiles.values()) {
      for (const contribution of analysis.modelContributions) {
        const modelName = contribution.name ?? contribution.inherit[0];
        if (!modelName || !inScope(modelName)) continue;

        // related='...' on field declarations
        for (const field of contribution.fields) {
          if (field.related) {
            const rootField = field.related.split('.')[0];
            this.references.addFieldUsage(modelName, rootField, {
              location: field.relatedLocation ?? field.location,
              kind: 'python-domain',
            });
          }
        }

        // @api.depends('a', 'b.c') on compute methods — use argLocations when present
        for (const method of contribution.methods) {
          const depDec = method.decorators.find((d) => d.name === 'api.depends' || d.name === 'depends');
          if (depDec) {
            depDec.args.forEach((dep, i) => {
              const rootField = dep.split('.')[0];
              const loc = depDec.argLocations?.[i] ?? method.location;
              this.references.addFieldUsage(modelName, rootField, {
                location: loc,
                kind: 'python-domain',
              });
            });
          }

          const selfModel = contribution.name ?? contribution.inherit[0];
          for (const chain of method.attributeChains) {
            for (const resolved of resolveAttributeChain(chain, selfModel, method.varBindings, this.models)) {
              if (!inScope(resolved.model)) continue;
              this.references.addFieldUsage(resolved.model, resolved.field, {
                location: resolved.location,
                kind: 'python-attribute',
                confidence: resolved.confidence,
              });
            }
          }
          for (const call of method.ormCalls) {
            if (call.targetModel && inScope(call.targetModel)) {
              this.references.addModelUsage(call.targetModel, { location: call.location, kind: 'python-attribute' });
            }
          }
        }
      }
    }
  }

  getModel(name: string): OdooModel | undefined {
    return this.models.get(name);
  }

  reverseModuleDependents(moduleName: string): string[] {
    return reverseDependents(this.modules, moduleName);
  }

  /** All contributions (methods) across the workspace that inherit-override a given model+method. */
  findMethodOverrides(model: string, methodName: string) {
    const m = this.models.get(model);
    if (!m) return [];
    return m.methodHistory.get(methodName) ?? [];
  }
}
