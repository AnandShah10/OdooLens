import { OdooDiagnostic } from '../../../semantic/OdooTypes';
import { PerformanceRule, RuleContext } from '../PerformanceRule';

/**
 * Additional ORM Doctor rules covering patterns from the original product plan that are
 * detectable with the data we already collect (ormCalls.rawText, loopDepth, targetModel).
 * Each rule is independently disableable via odooIntelligence.ormDoctor.rules.<id>.
 * None of these rewrite code — diagnostics only.
 */

/** Normalize a domain snippet for rough equivalence (whitespace/quote insensitive). */
function normalizeDomainSnippet(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(/['"]/g, '"').trim().slice(0, 120).toLowerCase();
}

/** Extract a rough domain list literal from search(...) raw text, if present. */
function domainKeyFromSearch(rawText: string): string | null {
  const m = rawText.match(/\.search\s*\(\s*(\[[\s\S]*?\])/);
  if (!m) return null;
  return normalizeDomainSnippet(m[1]);
}

export const repeatedEquivalentSearchRule: PerformanceRule = {
  id: 'repeated-equivalent-search',
  description: 'Multiple search() calls on the same model with equivalent domains in one method',
  run(ctx: RuleContext): OdooDiagnostic[] {
    if (ctx.enabledRules['repeated-equivalent-search'] === false) return [];
    const out: OdooDiagnostic[] = [];
    for (const contribution of ctx.analysis.modelContributions) {
      for (const method of contribution.methods) {
        // Group search calls by targetModel + domain key
        const groups = new Map<string, typeof method.ormCalls>();
        for (const call of method.ormCalls) {
          if (call.method !== 'search' && call.method !== 'search_read') continue;
          const domainKey = domainKeyFromSearch(call.rawText) ?? normalizeDomainSnippet(call.rawText);
          const modelKey = call.targetModel ?? '?';
          const key = `${modelKey}::${domainKey}`;
          const list = groups.get(key) ?? [];
          list.push(call);
          groups.set(key, list);
        }
        for (const [, calls] of groups) {
          if (calls.length < 2) continue;
          // Flag the second and later occurrences
          for (const call of calls.slice(1)) {
            out.push({
              ruleId: 'repeated-equivalent-search',
              message: `Possible repeated equivalent ${call.method}() on ${call.targetModel ?? 'the same model'} in ${method.name}. Consider reusing the first recordset instead of searching again with a similar domain.`,
              severity: 'information',
              confidence: 'low',
              location: call.location,
              category: 'performance',
              fixes: [],
            });
          }
        }
      }
    }
    return out;
  },
};

/**
 * Detects `.filtered(...)` after a search/browse in the same method body via source text —
 * a common "filter in Python instead of domain" pattern. Low confidence.
 */
export const pythonFilterAfterSearchRule: PerformanceRule = {
  id: 'python-filter-after-search',
  description: 'filtered() used where an ORM domain might push work to the database',
  run(ctx: RuleContext): OdooDiagnostic[] {
    if (ctx.enabledRules['python-filter-after-search'] === false) return [];
    const out: OdooDiagnostic[] = [];
    for (const contribution of ctx.analysis.modelContributions) {
      for (const method of contribution.methods) {
        const hasSearch = method.ormCalls.some(
          (c) => c.method === 'search' || c.method === 'search_read' || c.method === 'browse'
        );
        if (!hasSearch) continue;
        // Look at filtered/mapped ORM calls that are NOT already flagged as mapped-in-loop
        for (const call of method.ormCalls) {
          if (call.method !== 'filtered') continue;
          // filtered with a lambda that compares a field is the classic case; rawText is enough
          const looksLikeFieldPredicate =
            /filtered\s*\(\s*lambda/.test(call.rawText) ||
            /filtered\s*\(\s*['"][\w.]+['"]\s*\)/.test(call.rawText);
          if (!looksLikeFieldPredicate) continue;
          out.push({
            ruleId: 'python-filter-after-search',
            message: `filtered() in ${method.name} after a search/browse may be replaceable by an ORM domain on the original search (pushes filtering to SQL). Review whether the predicate can be expressed as a domain.`,
            severity: 'information',
            confidence: 'low',
            location: call.location,
            category: 'performance',
            fixes: [],
          });
        }
      }
    }
    return out;
  },
};

/**
 * search() domain uses a singleton `.id` inside a loop — classic N+1 shape even when the
 * search-in-loop rule already fires; this adds a more specific message for `= record.id`.
 */
export const singletonIdSearchInLoopRule: PerformanceRule = {
  id: 'singleton-id-search-in-loop',
  description: "search() with ('field', '=', x.id) inside a loop",
  run(ctx: RuleContext): OdooDiagnostic[] {
    if (ctx.enabledRules['singleton-id-search-in-loop'] === false) return [];
    const out: OdooDiagnostic[] = [];
    const idEq = /\[\s*\(\s*['"][\w.]+['"]\s*,\s*['"]=['"]\s*,\s*[\w.]+\.id\s*\)/;
    for (const contribution of ctx.analysis.modelContributions) {
      for (const method of contribution.methods) {
        for (const call of method.ormCalls) {
          if (!call.insideLoop) continue;
          if (call.method !== 'search' && call.method !== 'search_count' && call.method !== 'search_read') continue;
          if (!idEq.test(call.rawText)) continue;
          out.push({
            ruleId: 'singleton-id-search-in-loop',
            message: `${call.method}() in a loop uses a singleton ".id" equality domain in ${method.name}. Batch with ('field', 'in', recordset.ids) outside the loop instead.`,
            severity: 'warning',
            confidence: 'high',
            location: call.location,
            category: 'performance',
            fixes: [],
          });
        }
      }
    }
    return out;
  },
};

/** browse(single_id) where the argument is clearly a single int/id — often unnecessary. */
export const unnecessaryBrowseRule: PerformanceRule = {
  id: 'unnecessary-browse',
  description: 'browse() of a single id that may be replaceable by a recordset already in hand',
  run(ctx: RuleContext): OdooDiagnostic[] {
    if (ctx.enabledRules['unnecessary-browse'] === false) return [];
    const out: OdooDiagnostic[] = [];
    for (const contribution of ctx.analysis.modelContributions) {
      for (const method of contribution.methods) {
        for (const call of method.ormCalls) {
          if (call.method !== 'browse') continue;
          // browse(self.id) / browse(partner.id) / browse(1)
          if (!/\.browse\s*\(\s*[\w.]+\.id\s*\)|\.browse\s*\(\s*\d+\s*\)/.test(call.rawText)) continue;
          out.push({
            ruleId: 'unnecessary-browse',
            message: `browse() of a single id in ${method.name}. If you already hold a recordset, prefer ensuring it contains that id rather than browsing again.`,
            severity: 'hint',
            confidence: 'low',
            location: call.location,
            category: 'performance',
            fixes: [],
          });
        }
      }
    }
    return out;
  },
};

/** write({...}) on a singleton inside a loop — record-by-record writes. */
export const recordByRecordWriteRule: PerformanceRule = {
  id: 'record-by-record-write',
  description: 'write() inside a loop (record-by-record updates)',
  run(ctx: RuleContext): OdooDiagnostic[] {
    if (ctx.enabledRules['record-by-record-write'] === false) return [];
    const out: OdooDiagnostic[] = [];
    for (const contribution of ctx.analysis.modelContributions) {
      for (const method of contribution.methods) {
        for (const call of method.ormCalls) {
          if (call.method !== 'write' || !call.insideLoop) continue;
          out.push({
            ruleId: 'record-by-record-write',
            message: `write() inside a loop in ${method.name} updates records one-by-one. If values are identical, write once on the combined recordset; if not, consider batching with a single SQL update or grouped writes.`,
            severity: 'warning',
            confidence: 'medium',
            location: call.location,
            category: 'performance',
            fixes: [],
          });
        }
      }
    }
    return out;
  },
};

/** sudo() inside a loop — often accidental privilege escalation + expensive env rebuild. */
export const sudoInLoopRule: PerformanceRule = {
  id: 'sudo-in-loop',
  description: 'sudo() called inside a loop',
  run(ctx: RuleContext): OdooDiagnostic[] {
    if (ctx.enabledRules['sudo-in-loop'] === false) return [];
    const out: OdooDiagnostic[] = [];
    for (const contribution of ctx.analysis.modelContributions) {
      for (const method of contribution.methods) {
        for (const call of method.ormCalls) {
          if (call.method !== 'sudo' || !call.insideLoop) continue;
          out.push({
            ruleId: 'sudo-in-loop',
            message: `sudo() inside a loop in ${method.name}. Prefer elevating once before the loop (and narrowing the recordset) rather than re-entering sudo per iteration.`,
            severity: 'information',
            confidence: 'medium',
            location: call.location,
            category: 'performance',
            fixes: [],
          });
        }
      }
    }
    return out;
  },
};

export const additionalOrmRules: PerformanceRule[] = [
  repeatedEquivalentSearchRule,
  pythonFilterAfterSearchRule,
  singletonIdSearchInLoopRule,
  unnecessaryBrowseRule,
  recordByRecordWriteRule,
  sudoInLoopRule,
];
