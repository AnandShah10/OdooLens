import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { findDescendants } from '../parser/xml/XmlParser';
import { OdooMethodDecl, SourceLocation } from '../semantic/OdooTypes';

export interface RpcReachability {
  reachable: boolean;
  reason: string;
}

export interface ImpactResult {
  model: string;
  method: string;
  inheritedBy: { module: string; location: SourceLocation }[];
  calledFromPython: { model: string; method: string; location: SourceLocation }[];
  calledFromXmlButtons: { xmlId: string; file: string; location: SourceLocation }[];
  calledFromAutomation: { kind: 'cron' | 'server-action'; xmlId: string; name?: string; file: string; location: SourceLocation }[];
  /**
   * Whether this method is *reachable* via Odoo's XML-RPC/JSON-RPC `execute_kw()` API at all —
   * NOT a list of actual external callers, which is fundamentally unknowable from source code
   * alone (an external system could call any RPC-reachable method at any time). This is
   * deliberately the concrete, checkable static fact in place of the illusory "find RPC call
   * sites": in Odoo, any method whose name doesn't start with `_` is callable this way by any
   * authenticated user by default (subject to access rights), unless explicitly marked private.
   */
  rpcReachability: RpcReachability;
  confidenceNote: string;
}

/**
 * Computes the (best-effort static) blast radius of changing a model method, reusing the same
 * semantic index the dependency graph and hover features use — per the architecture requirement
 * that impact analysis must not implement a second, separate resolution engine.
 */
export function analyzeImpact(index: OdooWorkspaceIndex, model: string, method: string): ImpactResult {
  const history = index.findMethodOverrides(model, method);
  const inheritedBy = history.map((m) => ({ module: m.module, location: m.location }));

  const calledFromPython: ImpactResult['calledFromPython'] = [];
  for (const [modelName, m] of index.models) {
    for (const [, methodDecl] of m.methods) {
      if (methodDecl.model !== modelName) continue;
      if (methodDecl.calledMethods.includes(method) && modelName === model) {
        calledFromPython.push({ model: modelName, method: methodDecl.name, location: methodDecl.location });
      }
    }
  }

  const calledFromXmlButtons: ImpactResult['calledFromXmlButtons'] = [];
  for (const view of index.viewsById.values()) {
    if (view.model !== model || !view.archNode) continue;
    for (const btn of findDescendants(view.archNode, 'button')) {
      if (btn.attributes.type === 'object' && btn.attributes.name === method) {
        calledFromXmlButtons.push({ xmlId: view.xmlId, file: view.file, location: btn.location });
      }
    }
  }

  // ir.cron / ir.actions.server code fields are free-text Python snippets Odoo `exec()`s at
  // runtime (typically `model.method_name()` or `record.method_name()`), so this is
  // necessarily a TEXT search, not an AST-resolved call site — matched via a word-boundary
  // regex requiring the name to be immediately followed by `(`, to avoid matching the method
  // name appearing only in a comment or as a substring of a longer identifier.
  const methodCallPattern = new RegExp(`\\b${method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`);
  const calledFromAutomation: ImpactResult['calledFromAutomation'] = [];
  for (const cron of index.cronRecords) {
    if (cron.model === model && cron.code && methodCallPattern.test(cron.code)) {
      calledFromAutomation.push({ kind: 'cron', xmlId: cron.xmlId, name: cron.name, file: cron.file, location: cron.location });
    }
  }
  for (const action of index.serverActionRecords) {
    if (action.model === model && action.code && methodCallPattern.test(action.code)) {
      calledFromAutomation.push({ kind: 'server-action', xmlId: action.xmlId, name: action.name, file: action.file, location: action.location });
    }
  }

  const rpcReachability = computeRpcReachability(method, history);

  return {
    model,
    method,
    inheritedBy,
    calledFromPython,
    calledFromXmlButtons,
    calledFromAutomation,
    rpcReachability,
    confidenceNote:
      'Python call-site detection only matches direct `self.method_name(...)` calls within the same model and does not follow dynamic dispatch (getattr, super() chains beyond direct override listing, or calls via `env[...].method_name()` on a different variable). Scheduled/server action matches are a TEXT search over the record\'s `code` field (Odoo exec()s these as free-form Python at runtime, so there is no AST to resolve against) — a match is a real signal, but the absence of one is not proof the method is unreferenced, since the code field may call it indirectly. Actual external RPC callers can never be enumerated from source code alone — see `rpcReachability` for the concrete static fact OdooLens can offer instead (whether the method is exposed to RPC at all).',
  };
}

/**
 * Odoo exposes every model method whose name does NOT start with `_` to XML-RPC/JSON-RPC's
 * `execute_kw()` by default, callable by any authenticated user (subject to access rights) —
 * this is a documented Odoo ORM convention, not a guess. A method can opt out explicitly via
 * the `@api.private` decorator (Odoo 18.2+). This checks every declaration in the override
 * history: if ANY of them is missing `@api.private`, the method is reachable overall, since
 * Odoo's registry uses whichever implementation is active at runtime and a re-declaration
 * without the decorator would re-expose it.
 */
function computeRpcReachability(method: string, history: OdooMethodDecl[]): RpcReachability {
  if (method.startsWith('_')) {
    return { reachable: false, reason: 'Method name starts with "_", which Odoo treats as private and never exposes via XML-RPC/JSON-RPC.' };
  }
  const hasPrivateDecorator = history.length > 0 && history.every((h) => h.decorators.some((d) => d.name === 'api.private' || d.name === 'private'));
  if (hasPrivateDecorator) {
    return { reachable: false, reason: 'Every declaration of this method is marked @api.private (Odoo 18.2+), which explicitly excludes it from RPC exposure.' };
  }
  return {
    reachable: true,
    reason:
      'Public method name (no leading underscore) with no @api.private on any declaration — Odoo exposes this to XML-RPC/JSON-RPC callers by default, subject to the caller\'s access rights (ir.model.access.csv / ir.rule). This does not mean it IS being called externally, only that it CAN be.',
  };
}
