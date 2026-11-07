import { OdooDiagnostic } from '../../../semantic/OdooTypes';
import { PerformanceRule, RuleContext } from '../PerformanceRule';

/**
 * Flags read() / search_read() inside loops — classic N+1 when fetching fields per record.
 */
export const readInLoopRule: PerformanceRule = {
  id: 'read-in-loop',
  description: 'read()/search_read() inside a loop',
  helpUri: 'https://www.odoo.com/documentation/16.0/developer/reference/backend/orm.html',
  run(ctx: RuleContext): OdooDiagnostic[] {
    if (ctx.enabledRules['read-in-loop'] === false) return [];
    const out: OdooDiagnostic[] = [];
    for (const contribution of ctx.analysis.modelContributions) {
      for (const method of contribution.methods) {
        for (const call of method.ormCalls) {
          if (!call.insideLoop) continue;
          if (call.method !== 'read' && call.method !== 'search_read') continue;
          out.push({
            ruleId: 'read-in-loop',
            message: `"${call.method}()" executes inside a loop in ${method.name}. Prefer reading once for the full recordset (or using browse + field access) to avoid N+1 queries.`,
            severity: 'warning',
            confidence: 'high',
            location: call.location,
            helpUri: readInLoopRule.helpUri,
            category: 'performance',
            fixes: [
              {
                title: 'Batch read outside the loop',
                replacementText: undefined,
                isSafeAutoFix: false,
              },
            ],
          });
        }
      }
    }
    return out;
  },
};
