import { OdooDiagnostic } from '../../../semantic/OdooTypes';
import { PerformanceRule, RuleContext } from '../PerformanceRule';

/**
 * Flags ORM calls inside nested loops (loopDepth >= 2) — higher severity N+1 / N*M risk.
 */
export const nestedOrmLoopRule: PerformanceRule = {
  id: 'nested-orm-in-loop',
  description: 'ORM call inside nested loops (depth >= 2)',
  run(ctx: RuleContext): OdooDiagnostic[] {
    if (ctx.enabledRules['nested-orm-in-loop'] === false) return [];
    const out: OdooDiagnostic[] = [];
    const ORM = new Set(['search', 'browse', 'create', 'write', 'unlink', 'search_count', 'read', 'search_read']);
    for (const contribution of ctx.analysis.modelContributions) {
      for (const method of contribution.methods) {
        for (const call of method.ormCalls) {
          if (call.loopDepth < 2) continue;
          if (!ORM.has(call.method)) continue;
          out.push({
            ruleId: 'nested-orm-in-loop',
            message: `"${call.method}()" sits inside ${call.loopDepth} nested loops in ${method.name}. Nested-loop ORM access often scales as O(n*m) queries — batch or precompute where possible.`,
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
