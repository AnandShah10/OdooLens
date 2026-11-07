import { OdooDiagnostic } from '../../../semantic/OdooTypes';
import { PerformanceRule, RuleContext } from '../PerformanceRule';

interface Spec {
  id: string;
  method: string;
  suggestion: string;
}

const SPECS: Spec[] = [
  {
    id: 'search-in-loop',
    method: 'search',
    suggestion:
      "search() executes once per loop iteration. Consider batching: collect the relevant IDs first, then run a single search() with an 'in' domain outside the loop.",
  },
  {
    id: 'browse-in-loop',
    method: 'browse',
    suggestion:
      'browse() inside a loop usually means single-record work is being repeated. Prefer browsing the full ID list once outside the loop and iterating over the resulting recordset.',
  },
  {
    id: 'create-in-loop',
    method: 'create',
    suggestion:
      'create() inside a loop issues one INSERT per iteration. Prefer building a list of value dicts and calling create() once with the full list (create() accepts a list of dicts).',
  },
  {
    id: 'write-in-loop',
    method: 'write',
    suggestion:
      'write() inside a loop issues one UPDATE per record. If every record receives the same values, call write() once on the combined recordset instead.',
  },
  {
    id: 'unlink-in-loop',
    method: 'unlink',
    suggestion: 'unlink() inside a loop issues one DELETE per record. Prefer combining records into one recordset and calling unlink() once.',
  },
];

/** Detects ORM calls that execute once per loop iteration instead of being batched (N+1 pattern). */
export function makeOrmCallInLoopRules(): PerformanceRule[] {
  return SPECS.map((spec) => ({
    id: spec.id,
    description: `Detects ${spec.method}() called inside a loop, a classic N+1 ORM query pattern.`,
    helpUri: 'https://www.odoo.com/documentation/latest/developer/reference/backend/orm.html',
    run(ctx: RuleContext): OdooDiagnostic[] {
      if (ctx.enabledRules[spec.id] === false) return [];
      const diagnostics: OdooDiagnostic[] = [];
      for (const contribution of ctx.analysis.modelContributions) {
        for (const method of contribution.methods) {
          for (const call of method.ormCalls) {
            if (call.method !== spec.method || !call.insideLoop) continue;
            const nested = call.loopDepth >= 2;
            diagnostics.push({
              ruleId: spec.id,
              message: `Possible N+1 ORM query: ${spec.method}() executes once per loop iteration${
                nested ? ` (nested ${call.loopDepth} loops deep — this compounds quickly)` : ''
              }. ${spec.suggestion}`,
              severity: 'warning',
              confidence: nested ? 'high' : 'medium',
              location: call.location,
              helpUri: 'https://www.odoo.com/documentation/latest/developer/reference/backend/orm.html',
              category: 'performance',
              fixes: [
                {
                  title: `Show suggested fix for ${spec.method}() batching`,
                  isSafeAutoFix: false,
                },
              ],
            });
          }
        }
      }
      return diagnostics;
    },
  }));
}
