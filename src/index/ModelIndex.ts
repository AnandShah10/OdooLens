import { OdooModel, OdooModelContribution } from '../semantic/OdooTypes';

/**
 * Builds the merged, post-inheritance view of every Odoo model from a flat list of
 * per-class contributions. Contributions MUST be supplied in module-dependency order
 * (base modules first) so that `_inherit` overrides are applied in the same order Odoo's
 * registry would apply them; within a module, contributions are merged in file-scan order.
 *
 * Resolution rules implemented:
 *  - A contribution with `_name` (and no `_inherit`, or `_inherit == _name`) establishes
 *    a new logical model.
 *  - A contribution with `_inherit` pointing to an existing model extends it in place
 *    (classic inheritance): new fields/methods are added, same-named ones override.
 *  - A contribution with `_inherit` pointing to a model that doesn't exist yet is treated
 *    as an early forward-declaration and creates the model (this happens with unresolved
 *    external base modules, e.g. `sale` when only `custom_sale` is in the workspace).
 *  - `_inherits` (delegation) is recorded but does NOT flatten delegated fields onto the
 *    child model, matching Odoo's actual behavior (delegated fields are proxied, not copied).
 */
export function buildModelIndex(contributions: OdooModelContribution[]): Map<string, OdooModel> {
  const models = new Map<string, OdooModel>();

  const getOrCreate = (name: string): OdooModel => {
    let model = models.get(name);
    if (!model) {
      model = {
        name,
        contributions: [],
        fields: new Map(),
        fieldHistory: new Map(),
        methods: new Map(),
        methodHistory: new Map(),
        inheritsDelegated: {},
        modules: new Set(),
        isAbstract: false,
        isTransient: false,
      };
      models.set(name, model);
    }
    return model;
  };

  for (const contribution of contributions) {
    const primaryName = contribution.name ?? contribution.inherit[0];
    if (!primaryName) continue; // Can't resolve a logical model identity; skip (rare/edge case).

    const model = getOrCreate(primaryName);
    model.contributions.push(contribution);
    model.modules.add(contribution.module);
    Object.assign(model.inheritsDelegated, contribution.inherits);
    if (contribution.baseClass === 'AbstractModel') model.isAbstract = true;
    if (contribution.baseClass === 'TransientModel') model.isTransient = true;

    for (const field of contribution.fields) {
      const history = model.fieldHistory.get(field.name) ?? [];
      history.push(field);
      model.fieldHistory.set(field.name, history);
      model.fields.set(field.name, field); // last writer (per dependency order) wins
    }
    for (const method of contribution.methods) {
      const history = model.methodHistory.get(method.name) ?? [];
      history.push(method);
      model.methodHistory.set(method.name, history);
      model.methods.set(method.name, method);
    }

    // Additional `_inherit` targets beyond the primary one (Odoo allows a list, meaning
    // "extend all of these AND also register under the first name if `_name` is absent").
    for (const extra of contribution.inherit.slice(contribution.name ? 0 : 1)) {
      if (extra === primaryName) continue;
      const target = getOrCreate(extra);
      target.modules.add(contribution.module);
      for (const field of contribution.fields) {
        const history = target.fieldHistory.get(field.name) ?? [];
        history.push(field);
        target.fieldHistory.set(field.name, history);
        target.fields.set(field.name, field);
      }
      for (const method of contribution.methods) {
        const history = target.methodHistory.get(method.name) ?? [];
        history.push(method);
        target.methodHistory.set(method.name, history);
        target.methods.set(method.name, method);
      }
    }
  }

  return models;
}
