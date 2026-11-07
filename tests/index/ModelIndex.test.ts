import * as assert from 'assert';
import * as path from 'path';
import { OdooWorkspaceIndex, NodeFsAdapter } from '../../src/index/OdooIndex';

const EXT_ROOT = path.resolve(__dirname, '../..');
const FIXTURES_ROOT = path.join(EXT_ROOT, 'tests/fixtures/basic_odoo');

describe('ModelIndex (via OdooWorkspaceIndex.buildFull)', () => {
  it('merges fields and methods across base_module -> sale_extension -> custom_sale', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);

    const saleOrder = index.getModel('sale.order');
    assert.ok(saleOrder, 'expected sale.order to be indexed');

    // Fields from every contributing module should be present in the merged view.
    const fieldNames = Array.from(saleOrder!.fields.keys()).sort();
    assert.ok(fieldNames.includes('name')); // base_module
    assert.ok(fieldNames.includes('priority')); // sale_extension
    assert.ok(fieldNames.includes('x_unused_flag')); // custom_sale

    // action_confirm is declared in both base_module and sale_extension -> history length 2,
    // and the merged map should resolve to the LAST (most-derived) contribution.
    const history = saleOrder!.methodHistory.get('action_confirm') ?? [];
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].module, 'base_module');
    assert.strictEqual(history[1].module, 'sale_extension');

    assert.ok(saleOrder!.modules.has('base_module'));
    assert.ok(saleOrder!.modules.has('sale_extension'));
    assert.ok(saleOrder!.modules.has('custom_sale'));
  });

  it('merges res.partner contributed only by custom_sale', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const partner = index.getModel('res.partner');
    assert.ok(partner);
    assert.ok(partner!.fields.has('x_customer_score'));
    const field = partner!.fields.get('x_customer_score')!;
    assert.strictEqual(field.compute, '_compute_customer_score');
    assert.ok(field.dependsOn.includes('sale_order_ids'));
  });
});

describe('Python attribute-access tracking (ReferenceIndex)', () => {
  it('records a high-confidence usage of "state" from `order.state = ...` inside a for-loop over self', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const usages = index.references.getFieldUsages('sale.order', 'state');
    const attrUsage = usages.find((u) => u.kind === 'python-attribute');
    assert.ok(attrUsage, 'expected a python-attribute usage of "state" (previously untracked entirely)');
    assert.strictEqual(attrUsage!.confidence, 'high');
  });

  it('records a usage of "order_line" from a chained `order.order_line.mapped(...)` access', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const usages = index.references.getFieldUsages('sale.order', 'order_line');
    assert.ok(
      usages.some((u) => u.kind === 'python-attribute'),
      'expected the innermost field in a chained attribute access to be recorded, but not the trailing .mapped() call'
    );
  });

  it('does NOT record a usage for the trailing method name in a chained call ("mapped")', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const usages = index.references.getFieldUsages('sale.order', 'mapped');
    assert.strictEqual(usages.length, 0);
  });

  it('excludes framework attributes like "env" from field usages', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const usages = index.references.getFieldUsages('sale.order', 'env');
    assert.strictEqual(usages.length, 0);
  });

  it('does not count a direct method call (self.action_confirm()) as a field usage of "action_confirm"', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const usages = index.references.getFieldUsages('sale.order', 'action_confirm');
    assert.strictEqual(usages.length, 0);
  });

  it('follows a two-hop chain (self.partner_id.name) onto the comodel, with downgraded confidence', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);

    const partnerIdUsages = index.references.getFieldUsages('sale.order', 'partner_id');
    const highConfHit = partnerIdUsages.find((u) => u.kind === 'python-attribute' && u.confidence === 'high');
    assert.ok(highConfHit, 'expected a high-confidence usage of partner_id from self.partner_id.name');

    const nameUsages = index.references.getFieldUsages('res.partner', 'name');
    const chainedHit = nameUsages.find((u) => u.kind === 'python-attribute');
    assert.ok(chainedHit, 'expected the chain to continue onto res.partner.name, not stop at partner_id');
    assert.strictEqual(chainedHit!.confidence, 'medium', 'confidence should downgrade one step per hop (high -> medium)');
  });

  it('resolves a variable assigned from a chained attribute (partner = self.partner_id)', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);

    const nameUsages = index.references.getFieldUsages('res.partner', 'name');
    // get_partner_name, get_partner_via_variable, and get_filtered_partner_name should each
    // independently contribute a usage here.
    const pythonHits = nameUsages.filter((u) => u.kind === 'python-attribute');
    assert.ok(pythonHits.length >= 3, `expected at least 3 python-attribute usages of res.partner.name, got ${pythonHits.length}`);
  });

  it('follows a variable through a type-preserving method call (partner.filtered(...).name)', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);

    const analysis = index.pythonFiles.get(path.join(FIXTURES_ROOT, 'base_module/models/sale_order.py'))!;
    const contribution = analysis.modelContributions.find((c) => c.name === 'sale.order')!;
    const method = contribution.methods.find((m) => m.name === 'get_filtered_partner_name')!;
    assert.ok(method, 'expected the get_filtered_partner_name fixture method to be found');

    // The method should have captured a chainRef binding for `active_partner` whose source is
    // itself a chainRef with a `filtered` entry in `trailingMethods` over `partner`.
    const activePartnerBinding = method.varBindings.find((b) => b.varName === 'active_partner');
    assert.ok(activePartnerBinding, 'expected a var binding for active_partner');
    assert.strictEqual(activePartnerBinding!.source.kind, 'chainRef');
    if (activePartnerBinding!.source.kind === 'chainRef') {
      assert.strictEqual(activePartnerBinding!.source.trailingMethods[0]?.name, 'filtered');
    }
  });

  it('captures a chain of multiple method calls in one expression (.filtered(...).sorted())', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);

    const analysis = index.pythonFiles.get(path.join(FIXTURES_ROOT, 'base_module/models/sale_order.py'))!;
    const contribution = analysis.modelContributions.find((c) => c.name === 'sale.order')!;
    const method = contribution.methods.find((m) => m.name === 'get_chained_method_partner_name')!;
    assert.ok(method, 'expected the get_chained_method_partner_name fixture method to be found');

    const binding = method.varBindings.find((b) => b.varName === 'active_sorted_partner');
    assert.ok(binding);
    assert.strictEqual(binding!.source.kind, 'chainRef');
    if (binding!.source.kind === 'chainRef') {
      assert.deepStrictEqual(
        binding!.source.trailingMethods.map((m) => m.name),
        ['filtered', 'sorted']
      );
    }

    // And end-to-end: res.partner.name should have picked up a usage from this method too.
    const nameUsages = index.references.getFieldUsages('res.partner', 'name');
    const fromThisMethod = nameUsages.some(
      (u) => u.kind === 'python-attribute' && u.location.file === analysis.file
    );
    assert.ok(fromThisMethod, 'expected res.partner.name to have a usage recorded from this file');
  });
});
