import { Confidence, SourceLocation } from '../semantic/OdooTypes';

export interface FieldUsage {
  location: SourceLocation;
  kind: 'python-attribute' | 'python-domain' | 'xml-field' | 'xml-attrs' | 'report';
  /** Present for kinds derived from a heuristic model-context resolution (currently only
   *  'python-attribute'); absent for kinds that are exact by construction (XML tag/attribute
   *  matches, or `@api.depends()` string literals). */
  confidence?: Confidence;
}

/**
 * Tracks where each `model.field` combination is referenced across the workspace.
 *
 * IMPORTANT LIMITATION (documented per the false-positive-management requirement): this is
 * still a static, best-effort approximation, not full type inference. As of this version,
 * Python usages come from two sources with different precision:
 *
 *  1. **Resolved attribute access** (`kind: 'python-attribute'`, always carries a `confidence`):
 *     every `self.<field>` / `record.<field>` access (including assignment TARGETS, e.g.
 *     `order.amount_total = ...` inside a compute method) where `<record>` was resolved to a
 *     specific model via the same first-hop heuristics as the interactive completion/hover
 *     context resolver — see `AttributeAccessSite` in `semantic/OdooTypes.ts` and
 *     `parser/python/OdooModelExtractor.ts § collectAttributeAccesses`. This does NOT follow
 *     chained access (`record.partner_id.name` only yields a usage for `partner_id`), does not
 *     resolve arbitrary variables beyond that one-hop heuristic, and does not know about
 *     `getattr()`/dynamic attribute names.
 *  2. **`@api.depends()` path strings** (`kind: 'python-domain'`, no confidence — these are
 *     exact string literals from a decorator, not inferred) and ORM-call target models
 *     (`kind: 'python-attribute'` at the model level via `addModelUsage`, from resolved
 *     `self.env['x'].search(...)`-style calls).
 *
 * This trades perfect precision for safety in one direction: it is designed to avoid
 * *under-reporting* usages (which would cause incorrect "unused" dead-code findings or
 * incorrect "0 usages" in hover) more than it avoids over-counting. A dead-code finding is
 * suppressed by ANY usage regardless of confidence — a low-confidence usage is still treated as
 * "don't flag this", consistent with the analyzer's conservative-by-design philosophy.
 */
export class ReferenceIndex {
  private byModelField = new Map<string, FieldUsage[]>();
  private byModel = new Map<string, FieldUsage[]>();

  private key(model: string, field: string): string {
    return `${model}::${field}`;
  }

  addFieldUsage(model: string, field: string, usage: FieldUsage): void {
    const k = this.key(model, field);
    const list = this.byModelField.get(k) ?? [];
    list.push(usage);
    this.byModelField.set(k, list);
  }

  addModelUsage(model: string, usage: FieldUsage): void {
    const list = this.byModel.get(model) ?? [];
    list.push(usage);
    this.byModel.set(model, list);
  }

  getFieldUsages(model: string, field: string): FieldUsage[] {
    return this.byModelField.get(this.key(model, field)) ?? [];
  }

  getModelUsages(model: string): FieldUsage[] {
    return this.byModel.get(model) ?? [];
  }

  /** Removes all recorded usages for a single model (both model-level and field-level), so a
   *  scoped rebuild can repopulate just that model without discarding data for every other
   *  model in the workspace. */
  clearModel(model: string): void {
    this.byModel.delete(model);
    for (const key of Array.from(this.byModelField.keys())) {
      if (key.startsWith(`${model}::`)) this.byModelField.delete(key);
    }
  }

  clear(): void {
    this.byModelField.clear();
    this.byModel.clear();
  }
}
