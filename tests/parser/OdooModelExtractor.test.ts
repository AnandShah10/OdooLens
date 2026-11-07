import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { extractOdooModels } from '../../src/parser/python/OdooModelExtractor';

const EXT_ROOT = path.resolve(__dirname, '../..');
const FIXTURE = path.join(EXT_ROOT, 'tests/fixtures/basic_odoo/base_module/models/sale_order.py');

describe('OdooModelExtractor', () => {
  it('extracts _name, fields, and methods from a base model class', async () => {
    const source = fs.readFileSync(FIXTURE, 'utf8');
    const result = await extractOdooModels(FIXTURE, source, 'base_module', EXT_ROOT);
    assert.strictEqual(result.parseError, undefined);
    assert.strictEqual(result.modelContributions.length, 1);

    const contribution = result.modelContributions[0];
    assert.strictEqual(contribution.name, 'sale.order');
    assert.strictEqual(contribution.description, 'Sales Order');

    const fieldNames = contribution.fields.map((f) => f.name).sort();
    assert.deepStrictEqual(fieldNames, ['amount_total', 'name', 'order_line', 'partner_id', 'state']);

    const partnerId = contribution.fields.find((f) => f.name === 'partner_id')!;
    assert.strictEqual(partnerId.fieldType, 'Many2one');
    assert.strictEqual(partnerId.comodel, 'res.partner');

    // nameLocation must point at exactly the `partner_id` identifier (not the `fields.Many2one`
    // call), since this is what the rename provider rewrites in-place.
    const nameLine = source.split('\n')[partnerId.nameLocation.startLine];
    const nameText = nameLine.slice(partnerId.nameLocation.startCol, partnerId.nameLocation.endCol);
    assert.strictEqual(nameText, 'partner_id');

    const orderLine = contribution.fields.find((f) => f.name === 'order_line')!;
    assert.strictEqual(orderLine.fieldType, 'One2many');
    assert.strictEqual(orderLine.comodel, 'sale.order.line');
    assert.strictEqual(orderLine.inverseField, 'order_id');

    const amountTotal = contribution.fields.find((f) => f.name === 'amount_total')!;
    assert.strictEqual(amountTotal.compute, '_compute_amount_total');
    assert.deepStrictEqual(amountTotal.dependsOn.sort(), ['order_line', 'order_line.price_subtotal'].sort());

    const methodNames = contribution.methods.map((m) => m.name).sort();
    assert.ok(methodNames.includes('action_confirm'));
    assert.ok(methodNames.includes('find_orders_for_partners'));

    const computeMethod = contribution.methods.find((m) => m.name === '_compute_amount_total')!;
    assert.strictEqual(computeMethod.isCompute, true);
  });

  it('records ORM call sites and flags loop-nested calls', async () => {
    const source = fs.readFileSync(FIXTURE, 'utf8');
    const result = await extractOdooModels(FIXTURE, source, 'base_module', EXT_ROOT);
    const contribution = result.modelContributions[0];
    const method = contribution.methods.find((m) => m.name === 'find_orders_for_partners')!;
    const searchCall = method.ormCalls.find((c) => c.method === 'search')!;
    assert.ok(searchCall, 'expected a search() call to be recorded');
    assert.strictEqual(searchCall.insideLoop, true);
    assert.strictEqual(searchCall.targetModel, 'sale.order');

    const countMethod = contribution.methods.find((m) => m.name === 'count_all')!;
    const countCall = countMethod.ormCalls.find((c) => c.method === 'search_count')!;
    assert.strictEqual(countCall.insideLoop, false);
  });

  it('degrades gracefully on malformed Python instead of throwing', async () => {
    const badSource = 'class Broken(models.Model:\n    _name = \n';
    const result = await extractOdooModels('/tmp/broken.py', badSource, 'x', EXT_ROOT);
    // tree-sitter is error-tolerant and will still return a (possibly partial) parse,
    // so this should not throw and should return an array (possibly empty).
    assert.ok(Array.isArray(result.modelContributions));
  });
});
