import { OdooDiagnostic } from '../../../semantic/OdooTypes';
import { PerformanceRule, RuleContext } from '../PerformanceRule';

/**
 * Flags recordset.mapped(...) / filtered(...) / sorted(...) inside loops — often a sign of
 * per-iteration work that could be done once on the whole recordset before the loop.
 * Low/medium confidence: mapped inside a loop is sometimes intentional.
 */
export const mappedInLoopRule: PerformanceRule = {
  id: 'mapped-in-loop',
  description: 'mapped()/filtered()/sorted() inside a loop — consider computing once outside',
  helpUri: 'https://www.odoo.com/documentation/16.0/developer/reference/backend/orm.html#odoo.models.Model.mapped',
  run(ctx: RuleContext): OdooDiagnostic[] {
    if (ctx.enabledRules['mapped-in-loop'] === false) return [];
    const out: OdooDiagnostic[] = [];
    for (const contribution of ctx.analysis.modelContributions) {
      for (const method of contribution.methods) {
        for (const call of method.ormCalls) {
          if (!call.insideLoop) continue;
          if (call.method !== 'mapped' && call.method !== 'filtered' && call.method !== 'sorted') continue;
          out.push({
            ruleId: 'mapped-in-loop',
            message: `"${call.method}()" is called inside a loop in ${method.name}. If the recordset does not change per iteration, compute it once before the loop to avoid repeated work.`,
            severity: 'information',
            confidence: 'medium',
            location: call.location,
            helpUri: mappedInLoopRule.helpUri,
            category: 'performance',
            fixes: [],
          });
        }
      }
    }
    return out;
  },
};
