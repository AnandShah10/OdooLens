import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OdooWorkspaceIndex, NodeFsAdapter } from '../../src/index/OdooIndex';

const EXT_ROOT = path.resolve(__dirname, '../..');
const FIXTURES_ROOT = path.join(EXT_ROOT, 'tests/fixtures/basic_odoo');

describe('OdooWorkspaceIndex incremental updates', () => {
  it('leaves unrelated models untouched (same object reference) after updating an unrelated file', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);

    const partnerBefore = index.getModel('res.partner');
    assert.ok(partnerBefore);

    // Editing sale_order.py (which never touches res.partner) should not replace the
    // res.partner model object — proving the update was scoped, not a full re-merge.
    const saleOrderFile = path.join(FIXTURES_ROOT, 'custom_sale/models/sale_order.py');
    await index.updateFile(saleOrderFile, 'custom_sale');

    const partnerAfter = index.getModel('res.partner');
    assert.strictEqual(partnerAfter, partnerBefore, 'res.partner model object should be unchanged by an unrelated file update');
  });

  it('picks up a newly-added field on the affected model after an incremental update', async () => {
    const saleOrderFile = path.join(FIXTURES_ROOT, 'custom_sale/models/sale_order.py');
    const original = fs.readFileSync(saleOrderFile, 'utf8');
    const withNewField = original.replace(
      'x_unused_flag = fields.Boolean(default=False)',
      "x_unused_flag = fields.Boolean(default=False)\n    x_brand_new_field = fields.Char()"
    );

    class OverrideFs extends NodeFsAdapter {
      readFile(p: string): string {
        if (p === saleOrderFile) return withNewField;
        return super.readFile(p);
      }
    }

    const plainIndex = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await plainIndex.buildFull([FIXTURES_ROOT]);
    assert.ok(!plainIndex.getModel('sale.order')!.fields.has('x_brand_new_field'));

    (plainIndex as any).fsAdapter = new OverrideFs();
    await plainIndex.updateFile(saleOrderFile, 'custom_sale');
    assert.ok(plainIndex.getModel('sale.order')!.fields.has('x_brand_new_field'));
  });

  it('preserves reference-index usages for unrelated models after an incremental update', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);

    const partnerUsagesBefore = index.references.getFieldUsages('res.partner', 'sale_order_ids');
    assert.ok(partnerUsagesBefore.length > 0, 'expected a baseline usage to exist before the update');

    const saleOrderFile = path.join(FIXTURES_ROOT, 'custom_sale/models/sale_order.py');
    await index.updateFile(saleOrderFile, 'custom_sale');

    const partnerUsagesAfter = index.references.getFieldUsages('res.partner', 'sale_order_ids');
    assert.deepStrictEqual(partnerUsagesAfter, partnerUsagesBefore, 'res.partner usages should be untouched by an unrelated update');
  });
});

describe('OdooWorkspaceIndex persistent cache', () => {
  let cacheFile: string;

  beforeEach(() => {
    cacheFile = path.join(os.tmpdir(), `odoolens-test-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(cacheFile);
    } catch {
      // already absent — fine
    }
  });

  it('has zero cache hits on a cold (first-ever) build', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    index.cacheFilePath = cacheFile;
    const stats = await index.buildFull([FIXTURES_ROOT]);
    assert.strictEqual(stats.cacheHitCount, 0);
    assert.ok(fs.existsSync(cacheFile), 'expected the cache file to be written after a build');
  });

  it('serves every unchanged Python file from cache on a second build (simulating reopening the workspace)', async () => {
    const first = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    first.cacheFilePath = cacheFile;
    const firstStats = await first.buildFull([FIXTURES_ROOT]);
    assert.strictEqual(firstStats.cacheHitCount, 0);

    // A brand-new index instance, same cache file — simulates closing and reopening VS Code.
    const second = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    second.cacheFilePath = cacheFile;
    const secondStats = await second.buildFull([FIXTURES_ROOT]);
    assert.strictEqual(secondStats.pythonCacheHitCount, secondStats.pythonFileCount);
    assert.strictEqual(secondStats.modelCount, firstStats.modelCount, 'cached analyses should produce the same merged model index');

    // Sanity: the cached result is actually usable, not just structurally present.
    const model = second.getModel('sale.order');
    assert.ok(model);
    assert.ok(model!.fields.has('partner_id'));
  });

  it('invalidates only the changed file after its mtime is bumped', async () => {
    const first = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    first.cacheFilePath = cacheFile;
    await first.buildFull([FIXTURES_ROOT]);

    const saleOrderFile = path.join(FIXTURES_ROOT, 'base_module/models/sale_order.py');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(saleOrderFile, future, future);

    const second = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    second.cacheFilePath = cacheFile;
    const stats = await second.buildFull([FIXTURES_ROOT]);
    assert.strictEqual(stats.pythonCacheHitCount, stats.pythonFileCount - 1, 'exactly the touched file should miss the cache');
  });
});
