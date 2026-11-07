import { OdooDiagnostic } from '../../semantic/OdooTypes';
import { MigrationRule, OdooVersion, rulesForUpgrade } from '../../versioning/MigrationRules';

export interface MigrationFinding {
  rule: MigrationRule;
  file: string;
  line: number;
  lineText: string;
}

/**
 * Applies migration rules line-by-line against a file's source text. Rules are intentionally
 * regex/pattern based rather than full semantic analysis (see MigrationRules.ts) — this keeps
 * every rule auditable in one data file, at the cost of not understanding context (e.g. a
 * `sudo(True)` inside a comment or string will still match). This trade-off is documented and
 * acceptable for a migration *report* whose job is to point a human at candidate locations.
 */
export function runMigrationAnalyzer(
  file: string,
  source: string,
  from: OdooVersion,
  to: OdooVersion,
  kind?: 'python' | 'xml'
): MigrationFinding[] {
  // `kind` scopes rules to the file type they're written for: an `xml`-category rule's regex is
  // meaningless (and could misfire) against Python source, and vice versa. Omitted = apply all
  // rules (kept so existing callers/tests that don't care about file type still work).
  const rules = rulesForUpgrade(from, to).filter((r) => (kind === undefined ? true : kind === 'xml' ? r.category === 'xml' : r.category !== 'xml'));
  if (rules.length === 0) return [];
  const compiled = rules.map((r) => ({ rule: r, re: new RegExp(r.pattern, r.patternFlags ?? '') }));
  const lines = source.split(/\r?\n/);
  const findings: MigrationFinding[] = [];

  lines.forEach((lineText, idx) => {
    for (const { rule, re } of compiled) {
      if (re.test(lineText)) {
        findings.push({ rule, file, line: idx, lineText: lineText.trim() });
      }
    }
  });

  return findings;
}

export function findingsToDiagnostics(findings: MigrationFinding[]): OdooDiagnostic[] {
  return findings.map((f) => ({
    ruleId: f.rule.id,
    message: `${f.rule.message}${f.rule.replacement ? ` Suggested change: ${f.rule.replacement}` : ''}`,
    severity: f.rule.severity,
    confidence: f.rule.confidence,
    location: { file: f.file, startLine: f.line, startCol: 0, endLine: f.line, endCol: f.lineText.length },
    category: 'migration',
    helpUri: f.rule.documentationUrl,
    fixes: [],
  }));
}
