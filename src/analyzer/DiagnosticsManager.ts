import * as vscode from 'vscode';
import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { runOrmDoctor } from './performance/OrmDoctor';
import { runSecurityAnalyzer } from './security/SecurityAnalyzer';
import { runAclAnalyzer } from './security/AclAnalyzer';
import { analyzeXmlFile, findDuplicateXmlIds, findUnresolvedXmlRefs } from './xml/XmlAnalyzer';
import { analyzeQwebTemplates } from './xml/QwebAnalyzer';
import { runDeadCodeAnalyzer, DeadCodeConfidence } from './deadCode/DeadCodeAnalyzer';
import { toVscodeDiagnostic } from '../utils/VscodeConvert';
import { OdooDiagnostic } from '../semantic/OdooTypes';

function config() {
  return vscode.workspace.getConfiguration('odooIntelligence');
}

export class DiagnosticsManager {
  // Per-file diagnostics (ORM Doctor, security-in-code, XML-per-file) live in one collection,
  // keyed by that file's own findings only — `refreshFile()` fully replaces a file's entries.
  private collection = vscode.languages.createDiagnosticCollection('odooLens');
  // Workspace-wide diagnostics (dead code, duplicate XML ids, ACL/record-rule checks) live in a
  // SEPARATE collection, because they can touch any file and must be fully recomputed-and-
  // replaced on every call — mixing them into `collection` previously meant every incremental
  // re-index would append duplicate copies forever instead of replacing stale findings.
  private workspaceCollection = vscode.languages.createDiagnosticCollection('odooLensWorkspace');

  // Mirrors of the two collections above, but keeping the RAW `OdooDiagnostic` (category,
  // confidence, ruleId as data, not stuffed into a message string) rather than the converted
  // `vscode.Diagnostic` — the Problems tree view needs this to group by category/confidence,
  // which isn't recoverable from a `vscode.Diagnostic` alone.
  private rawPerFile = new Map<string, OdooDiagnostic[]>();
  private rawWorkspaceWide = new Map<string, OdooDiagnostic[]>();

  private changeEmitter = new vscode.EventEmitter<void>();
  /** Fires after any refresh (per-file or workspace-wide) completes — tree views subscribe to
   *  this to know when to re-render rather than polling. */
  readonly onDidChangeDiagnostics = this.changeEmitter.event;

  constructor(private index: OdooWorkspaceIndex) {}

  dispose(): void {
    this.collection.dispose();
    this.workspaceCollection.dispose();
    this.changeEmitter.dispose();
  }

  clear(): void {
    this.collection.clear();
    this.workspaceCollection.clear();
    this.rawPerFile.clear();
    this.rawWorkspaceWide.clear();
  }

  /** All currently-published diagnostics (per-file + workspace-wide combined), for consumers
   *  that need the raw `category`/`confidence` data — currently just the Problems tree view. */
  getAllDiagnostics(): OdooDiagnostic[] {
    const all: OdooDiagnostic[] = [];
    for (const ds of this.rawPerFile.values()) all.push(...ds);
    for (const ds of this.rawWorkspaceWide.values()) all.push(...ds);
    return all;
  }

  refreshWorkspaceWideDiagnostics(): void {
    this.workspaceCollection.clear();
    this.rawWorkspaceWide.clear();
    const all: OdooDiagnostic[] = [];

    if (config().get<boolean>('enableDeadCodeAnalyzer', true)) {
      const minConfidence = config().get<DeadCodeConfidence>('deadCode.minConfidence', 'probably_unused');
      all.push(...runDeadCodeAnalyzer(this.index, minConfidence));
    }
    if (config().get<boolean>('enableXMLAnalyzer', true)) {
      all.push(...findDuplicateXmlIds(this.index));
      all.push(...findUnresolvedXmlRefs(this.index));
      all.push(...analyzeQwebTemplates(this.index));
    }
    if (config().get<boolean>('enableSecurityAnalyzer', true)) {
      all.push(...runAclAnalyzer(this.index, config().get('security.aclRules', {})));
    }

    this.publishGroupedTo(this.workspaceCollection, this.rawWorkspaceWide, all);
    this.changeEmitter.fire();
  }

  refreshFile(file: string): void {
    this.refreshFileInternal(file);
    this.changeEmitter.fire();
  }

  private refreshFileInternal(file: string): void {
    const diagnostics: OdooDiagnostic[] = [];
    const cfg = config();

    if (file.endsWith('.py')) {
      const analysis = this.index.pythonFiles.get(file);
      if (analysis) {
        if (cfg.get<boolean>('enableORMDoctor', true) && cfg.get<boolean>('ormDoctor.enabled', true)) {
          const rules = cfg.get<Record<string, boolean>>('ormDoctor.rules', {});
          diagnostics.push(...runOrmDoctor(analysis, '', rules));
        }
        if (cfg.get<boolean>('enableSecurityAnalyzer', true)) {
          diagnostics.push(...runSecurityAnalyzer(analysis, cfg.get('security.rules', {})));
        }
      }
    } else if (file.endsWith('.xml')) {
      const xmlFile = this.index.xmlFiles.get(file);
      if (xmlFile && cfg.get<boolean>('enableXMLAnalyzer', true)) {
        diagnostics.push(...analyzeXmlFile(this.index, xmlFile));
      }
    }

    this.collection.set(vscode.Uri.file(file), diagnostics.map(toVscodeDiagnostic));
    if (diagnostics.length > 0) this.rawPerFile.set(file, diagnostics);
    else this.rawPerFile.delete(file);
  }

  /** Refreshes every indexed file plus workspace-wide diagnostics, firing the change event
   *  exactly ONCE at the end rather than once per file — a full rebuild of a large workspace
   *  would otherwise fire dozens/hundreds of redundant tree-view re-render events. */
  refreshAllFiles(): void {
    this.collection.clear();
    this.rawPerFile.clear();
    for (const file of this.index.pythonFiles.keys()) this.refreshFileInternal(file);
    for (const file of this.index.xmlFiles.keys()) this.refreshFileInternal(file);
    this.refreshWorkspaceWideDiagnostics(); // also fires the change event, once
  }

  private publishGroupedTo(
    collection: vscode.DiagnosticCollection,
    rawTarget: Map<string, OdooDiagnostic[]>,
    diagnostics: OdooDiagnostic[]
  ): void {
    const byFile = new Map<string, OdooDiagnostic[]>();
    for (const d of diagnostics) {
      const arr = byFile.get(d.location.file) ?? [];
      arr.push(d);
      byFile.set(d.location.file, arr);
    }
    for (const [file, ds] of byFile) {
      collection.set(vscode.Uri.file(file), ds.map(toVscodeDiagnostic));
      rawTarget.set(file, ds);
    }
  }
}
