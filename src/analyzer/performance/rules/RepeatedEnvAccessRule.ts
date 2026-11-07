import { OdooDiagnostic } from '../../../semantic/OdooTypes';
import { PerformanceRule, RuleContext } from '../PerformanceRule';

const THRESHOLD = 3; // Number of separate self.env['x'] accesses to the same model before flagging.

/**
 * Detects a method that accesses `self.env['same.model']` three or more times, independent of
 * whether each access is chained into an ORM call. Each `self.env[...]` subscript does a
 * registry lookup; caching the recordset in a local variable once avoids repeating that lookup
 * and, more importantly, signals intent to the reader ("this is the same model throughout").
 *
 * This is a lower-confidence, informational rule compared to the loop-based N+1 rules: repeated
 * access outside a loop is a readability/micro-perf nit, not a correctness issue, so it is
 * reported at 'low' confidence and 'information' severity.
 */
export const repeatedEnvAccessRule: PerformanceRule = {
  id: 'repeated-env-access',
  description: 'Detects a method that looks up self.env[...] for the same model three or more times.',
  run(ctx: RuleContext): OdooDiagnostic[] {
    if (ctx.enabledRules['repeated-env-access'] === false) return [];
    const diagnostics: OdooDiagnostic[] = [];
    for (const contribution of ctx.analysis.modelContributions) {
      for (const method of contribution.methods) {
        const byModel = new Map<string, number>();
        for (const access of method.envAccesses) {
          byModel.set(access.model, (byModel.get(access.model) ?? 0) + 1);
        }
        for (const [model, count] of byModel) {
          if (count < THRESHOLD) continue;
          // Report once, at the method's own location (not each individual access site), since
          // the finding is about the method's overall structure rather than any single line.
          diagnostics.push({
            ruleId: 'repeated-env-access',
            message: `self.env['${model}'] is looked up ${count} separate times in ${method.name}(). Consider assigning it to a local variable once (e.g. \`${modelVarName(
              model
            )} = self.env['${model}']\`) at the top of the method for clarity and to avoid repeating the registry lookup.`,
            severity: 'information',
            confidence: 'low',
            location: method.location,
            category: 'performance',
            fixes: [],
          });
        }
      }
    }
    return diagnostics;
  },
};

function modelVarName(model: string): string {
  return model.replace(/\./g, '_');
}
