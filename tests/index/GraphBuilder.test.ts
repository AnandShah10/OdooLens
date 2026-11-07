import * as assert from 'assert';
import * as path from 'path';
import { OdooWorkspaceIndex, NodeFsAdapter } from '../../src/index/OdooIndex';
import { buildModuleGraph, buildModelGraph, buildUnifiedModelGraph } from '../../src/webview/graph/GraphBuilder';

const EXT_ROOT = path.resolve(__dirname, '../..');
const FIXTURES_ROOT = path.join(EXT_ROOT, 'tests/fixtures/basic_odoo');

describe('GraphBuilder', () => {
  it('buildModuleGraph includes all three fixture modules and their depends-on edges', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const data = buildModuleGraph(index);
    const moduleIds = data.nodes.filter((n) => n.kind === 'module').map((n) => n.id);
    assert.ok(moduleIds.includes('base_module'));
    assert.ok(moduleIds.includes('sale_extension'));
    assert.ok(moduleIds.includes('custom_sale'));
    assert.ok(data.edges.some((e) => e.from === 'sale_extension' && e.to === 'base_module'));
  });

  it('buildModelGraph includes contributing modules and relational comodels', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const data = buildModelGraph(index, 'sale.order');
    const moduleNodeIds = data.nodes.filter((n) => n.kind === 'module').map((n) => n.id);
    assert.ok(moduleNodeIds.includes('module:base_module'));
    assert.ok(data.nodes.some((n) => n.id === 'res.partner')); // via partner_id comodel
  });

  it('buildUnifiedModelGraph groups fields/methods/views/security under category nodes', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const data = buildUnifiedModelGraph(index, 'sale.order');

    const categoryLabels = data.nodes.filter((n) => n.kind === 'category').map((n) => n.label);
    assert.ok(categoryLabels.some((l) => l.startsWith('Fields')));
    assert.ok(categoryLabels.some((l) => l.startsWith('Methods')));
    assert.ok(categoryLabels.some((l) => l.startsWith('Views')));
    assert.ok(categoryLabels.some((l) => l.startsWith('Security')));

    // Every field on sale.order should appear as its own node.
    const fieldNodeIds = data.nodes.filter((n) => n.kind === 'field').map((n) => n.id);
    assert.ok(fieldNodeIds.includes('field:sale.order.partner_id'));
    assert.ok(fieldNodeIds.includes('field:sale.order.amount_total'));

    // partner_id, being relational, should also link out to its comodel.
    assert.ok(data.edges.some((e) => e.from === 'field:sale.order.partner_id' && e.to === 'res.partner'));

    // A method node should exist for action_confirm.
    assert.ok(data.nodes.some((n) => n.id === 'method:sale.order.action_confirm'));

    // The record rule + access rule fixtures should surface under Security.
    const accessNodeIds = data.nodes.filter((n) => n.kind === 'accessRule').map((n) => n.id);
    const ruleNodeIds = data.nodes.filter((n) => n.kind === 'recordRule').map((n) => n.id);
    assert.ok(accessNodeIds.length >= 2, 'expected at least the base + writeonly access rows');
    assert.ok(ruleNodeIds.length >= 1, 'expected the permissive ir.rule fixture to appear');
  });

  it('buildUnifiedModelGraph returns just the model node for an unknown model', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const data = buildUnifiedModelGraph(index, 'does.not.exist');
    assert.strictEqual(data.nodes.length, 1);
    assert.strictEqual(data.edges.length, 0);
  });
});
