import { ChainRefShape, Confidence, OdooModel, RawAttributeChain, RawVarBinding, SourceLocation } from '../semantic/OdooTypes';

// Mirrors the extractor's TYPE_PRESERVING_METHODS whitelist (see OdooModelExtractor.ts) —
// recordset methods documented by Odoo to return the SAME model they were called on.
const TYPE_PRESERVING_METHODS = new Set([
  'filtered',
  'filtered_domain',
  'sorted',
  'exists',
  'with_context',
  'with_user',
  'with_company',
  'sudo',
  'browse',
  'ensure_one',
  'copy',
  'search',
]);

// Framework/internal self-attributes that are never real Odoo fields, excluded so they don't
// pollute the reference index with entries nobody will ever query (`model.fields` never
// contains these, so it's harmless either way, but excluding them keeps the index cleaner).
const NON_FIELD_SELF_ATTRS = new Set([
  'env',
  'ids',
  'pool',
  'cr',
  'uid',
  'context',
  '_cr',
  '_uid',
  '_context',
  '_name',
  '_inherit',
  '_description',
]);

export interface ResolvedFieldAccess {
  model: string;
  field: string;
  location: SourceLocation;
  confidence: Confidence;
}

function downgrade(c: Confidence): Confidence {
  return c === 'high' ? 'medium' : 'low';
}

interface ChainStep {
  model: string;
  confidence: Confidence;
  field: string;
  comodel?: string;
}

/** Shared chain-walking core used by both `resolveAttributeChain` (which needs per-segment
 *  locations, for recording usages) and `resolveVarModel`'s `chainRef` case (which only needs
 *  the FINAL type, to resolve a variable like `partner = self.partner_id`). Stops the moment a
 *  segment's field isn't found or isn't relational — the returned array is only as long as it
 *  could actually walk, which callers use to detect "did this fully resolve". */
function walkChainSteps(
  startModel: string,
  startConfidence: Confidence,
  fieldNames: string[],
  models: Map<string, OdooModel>
): ChainStep[] {
  const steps: ChainStep[] = [];
  let current = { model: startModel, confidence: startConfidence };
  for (const field of fieldNames) {
    const fieldDecl = models.get(current.model)?.fields.get(field);
    steps.push({ model: current.model, confidence: current.confidence, field, comodel: fieldDecl?.comodel });
    if (!fieldDecl?.comodel) break;
    current = { model: fieldDecl.comodel, confidence: downgrade(current.confidence) };
  }
  return steps;
}

/**
 * Resolves a `ChainRefShape` (a base + field chain, optionally followed by ONE type-transforming
 * method call) to a final model + confidence. Shared by the `chainRef` and `forLoopOverChain`
 * binding cases below — they differ only in the syntactic context (assignment vs. for-loop
 * target) the shape was captured from, not in how it's resolved.
 */
function resolveChainRefShape(
  shape: ChainRefShape,
  bindings: RawVarBinding[],
  selfModel: string | undefined,
  models: Map<string, OdooModel>,
  maxDepth: number
): { model: string; confidence: Confidence } | null {
  const initial = resolveVarModel(shape.baseRef, bindings, selfModel, models, maxDepth - 1);
  if (!initial) return null;
  let current: { model: string; confidence: Confidence } = initial;

  if (shape.fields.length > 0) {
    const steps = walkChainSteps(current.model, current.confidence, shape.fields, models);
    if (steps.length !== shape.fields.length) return null; // broke before reaching the end
    const last = steps[steps.length - 1];
    if (!last.comodel) return null; // chain ends on a non-relational field — not a recordset
    current = { model: last.comodel, confidence: downgrade(last.confidence) };
  }

  if (shape.trailingMethods.length > 0) {
    for (const { name, arg } of shape.trailingMethods) {
      if (TYPE_PRESERVING_METHODS.has(name)) {
        // Model unchanged. Confidence unchanged too — these are well-documented Odoo API
        // semantics, not a heuristic guess, so no extra downgrade for this hop.
        continue;
      }
      if (name === 'mapped' && arg) {
        const fieldDecl = models.get(current.model)?.fields.get(arg);
        if (!fieldDecl?.comodel) return null; // mapped() over a non-relational field returns a
        // plain list, not a recordset — there's no model to resolve to.
        current = { model: fieldDecl.comodel, confidence: downgrade(current.confidence) };
        continue;
      }
      return null; // unrecognized trailing method — don't guess its return type
    }
  }

  return current;
}

/**
 * Resolves a variable name (or the literal `'self'`) to a model + confidence, walking through
 * `copyVar`/`forLoopOverVar`/`chainRef`/`forLoopOverChain` indirection as needed — including
 * MULTI-segment chains (`for x in a.b.c:`) and type-preserving method calls
 * (`var = var.filtered(...)`, `var = var.mapped('field')`), not just a single hop. Resolution
 * recurses through as many links as the bindings chain contains, bounded by `maxDepth` purely as
 * a cycle guard against pathological `a = b; b = a` code, not a real design limit.
 *
 * Returns null when the chain bottoms out at something OdooLens can't resolve (an unassigned
 * name, a binding this pass doesn't understand, an unrecognized method call, or a field that
 * isn't a known relational field) — callers must treat that as "unknown", not fall back to
 * guessing.
 */
export function resolveVarModel(
  varName: string,
  bindings: RawVarBinding[],
  selfModel: string | undefined,
  models: Map<string, OdooModel>,
  maxDepth = 10
): { model: string; confidence: Confidence } | null {
  if (varName === 'self') {
    return selfModel ? { model: selfModel, confidence: 'high' } : null;
  }
  if (maxDepth <= 0) return null;

  const binding = bindings.find((b) => b.varName === varName);
  if (!binding) return null;

  switch (binding.source.kind) {
    case 'self':
    case 'forLoopOverSelf':
      return selfModel ? { model: selfModel, confidence: 'high' } : null;

    case 'envLookup':
      return { model: binding.source.model, confidence: 'medium' };

    case 'copyVar':
      return resolveVarModel(binding.source.fromVar, bindings, selfModel, models, maxDepth - 1);

    case 'chainRef':
    case 'forLoopOverChain':
      return resolveChainRefShape(binding.source, bindings, selfModel, models, maxDepth);

    case 'forLoopOverVar': {
      const base = resolveVarModel(binding.source.fromVar, bindings, selfModel, models, maxDepth - 1);
      return base ? { model: base.model, confidence: downgrade(base.confidence) } : null;
    }
  }
}

/**
 * Walks a raw attribute chain (`order.partner_id.name`) as far as the fully-merged model index
 * lets it: resolve the base, then for each segment look up the field on the CURRENT model. If
 * the field exists and is relational, advance to its comodel (confidence downgrades one step per
 * hop) and continue; otherwise stop after recording that segment. This is the "chained-access
 * following" piece — a field two, three, or more relational hops away from `self`/a local
 * variable is now tracked, not just the first hop.
 *
 * Every segment visited (including ones where the field turns out not to exist in the merged
 * index) is recorded as an attempted access on whatever model was current at that point, EXCEPT
 * framework-internal names (`env`, `ids`, etc.) which are dropped entirely.
 */
export function resolveAttributeChain(
  chain: RawAttributeChain,
  selfModel: string | undefined,
  bindings: RawVarBinding[],
  models: Map<string, OdooModel>
): ResolvedFieldAccess[] {
  const base = resolveVarModel(chain.baseRef, bindings, selfModel, models);
  if (!base) return [];

  const steps = walkChainSteps(
    base.model,
    base.confidence,
    chain.segments.map((s) => s.field),
    models
  );

  const results: ResolvedFieldAccess[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (NON_FIELD_SELF_ATTRS.has(step.field)) continue;
    results.push({ model: step.model, field: step.field, location: chain.segments[i].location, confidence: step.confidence });
  }
  return results;
}
