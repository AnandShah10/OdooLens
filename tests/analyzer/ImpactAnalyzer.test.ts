import * as assert from 'assert';
import * as path from 'path';
import { OdooWorkspaceIndex, NodeFsAdapter } from '../../src/index/OdooIndex';
import { analyzeImpact } from '../../src/analyzer/ImpactAnalyzer';

const EXT_ROOT = path.resolve(__dirname, '../..');
const FIXTURES_ROOT = path.join(EXT_ROOT, 'tests/fixtures/basic_odoo');

describe('ImpactAnalyzer', () => {
  it('finds override history for action_confirm across base_module and sale_extension', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const result = analyzeImpact(index, 'sale.order', 'action_confirm');
    assert.strictEqual(result.inheritedBy.length, 2);
    assert.deepStrictEqual(
      result.inheritedBy.map((i) => i.module),
      ['base_module', 'sale_extension']
    );
  });

  it('finds the XML button calling action_confirm', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const result = analyzeImpact(index, 'sale.order', 'action_confirm');
    assert.ok(result.calledFromXmlButtons.some((b) => b.xmlId === 'base_module.view_sale_order_form'));
  });

  it('finds the ir.cron record whose code field calls action_confirm', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const result = analyzeImpact(index, 'sale.order', 'action_confirm');
    const cronHit = result.calledFromAutomation.find((a) => a.kind === 'cron');
    assert.ok(cronHit, 'expected the cron_auto_confirm_orders fixture to be matched');
    assert.strictEqual(cronHit!.xmlId, 'custom_sale.cron_auto_confirm_orders');
  });

  it('does not false-positive match a method name that only appears as a substring', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    // "confirm" is a substring of "action_confirm" but not a real method on sale.order.
    const result = analyzeImpact(index, 'sale.order', 'confirm');
    assert.strictEqual(result.calledFromAutomation.length, 0);
  });

  it('reports a public method (no underscore, no @api.private) as RPC-reachable', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const result = analyzeImpact(index, 'sale.order', 'action_confirm');
    assert.strictEqual(result.rpcReachability.reachable, true);
    assert.match(result.rpcReachability.reason, /XML-RPC\/JSON-RPC callers by default/);
  });

  it('reports an underscore-prefixed method as NOT RPC-reachable', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const result = analyzeImpact(index, 'sale.order', '_compute_amount_total');
    assert.strictEqual(result.rpcReachability.reachable, false);
    assert.match(result.rpcReachability.reason, /starts with "_"/);
  });

  it('reports a method marked @api.private as NOT RPC-reachable even without an underscore', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const result = analyzeImpact(index, 'sale.order', 'internal_helper_without_underscore');
    assert.strictEqual(result.rpcReachability.reachable, false);
    assert.match(result.rpcReachability.reason, /@api\.private/);
  });

  it('returns empty (not throwing) for a method with no overrides/callers', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const result = analyzeImpact(index, 'sale.order', 'trigger_confirm');
    assert.strictEqual(result.calledFromAutomation.length, 0);
    assert.strictEqual(result.calledFromXmlButtons.length, 0);
  });
});
