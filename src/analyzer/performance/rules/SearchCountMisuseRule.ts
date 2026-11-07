import { OdooDiagnostic } from '../../../semantic/OdooTypes';
import { PerformanceRule, RuleContext } from '../PerformanceRule';

/**
 * Flags `search_count([])` (or effectively-empty-domain) calls, which count every record of
 * the target model. This is often unintentional and can be expensive on large tables.
 */
export const searchCountMisuseRule: PerformanceRule = {
  id: 'search-count-misuse',
  description: 'Detects search_count() called with an empty domain, which counts the entire table.',
  run(ctx: RuleContext): OdooDiagnostic[] {
    if (ctx.enabledRules['search-count-misuse'] === false) return [];
    const diagnostics: OdooDiagnostic[] = [];
    for (const contribution of ctx.analysis.modelContributions) {
      for (const method of contribution.methods) {
        for (const call of method.ormCalls) {
          if (call.method !== 'search_count') continue;
          const emptyDomain = /search_count\s*\(\s*\[\s*\]\s*\)/.test(call.rawText);
          if (!emptyDomain) continue;
          diagnostics.push({
            ruleId: 'search-count-misuse',
            message:
              'search_count([]) counts every record in the table. If you only need to know whether any records exist, consider search([], limit=1) with a boolean check instead.',
            severity: 'information',
            confidence: 'medium',
            location: call.location,
            category: 'performance',
            fixes: [],
          });
        }
      }
    }
    return diagnostics;
  },
};
