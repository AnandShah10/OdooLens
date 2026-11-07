import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseXml, findDescendants } from '../../src/parser/xml/XmlParser';
import { extractViewRecords } from '../../src/parser/xml/ViewExtractor';
import { mergeViewChain } from '../../src/parser/xml/ViewMerger';
import { locateAttributeValue } from '../../src/parser/xml/AttributeLocator';
import { extractRuleRecords } from '../../src/parser/xml/RuleExtractor';
import { extractCronRecords, extractServerActionRecords } from '../../src/parser/xml/AutomationRecordExtractor';

const FIXTURES_ROOT = path.resolve(__dirname, '../../tests/fixtures/basic_odoo');

describe('XmlParser', () => {
  it('parses a view record with correct source locations', () => {
    const file = path.join(FIXTURES_ROOT, 'base_module/views/sale_order_views.xml');
    const source = fs.readFileSync(file, 'utf8');
    const { root, errors } = parseXml(file, source);
    assert.strictEqual(errors.length, 0);
    assert.ok(root);
    const fields = findDescendants(root!, 'field');
    assert.ok(fields.length >= 4);
    const partnerField = fields.find((f) => f.attributes.name === 'partner_id');
    assert.ok(partnerField);
    assert.ok(partnerField!.location.startLine > 0);
  });
});

describe('ViewMerger', () => {
  it('applies an xpath "after" patch onto the base view', () => {
    const baseFile = path.join(FIXTURES_ROOT, 'base_module/views/sale_order_views.xml');
    const patchFile = path.join(FIXTURES_ROOT, 'sale_extension/views/sale_order_views.xml');

    const baseParsed = parseXml(baseFile, fs.readFileSync(baseFile, 'utf8'));
    const patchParsed = parseXml(patchFile, fs.readFileSync(patchFile, 'utf8'));
    const baseViews = extractViewRecords(baseParsed.root!, 'base_module', baseFile);
    const patchViews = extractViewRecords(patchParsed.root!, 'sale_extension', patchFile);

    const base = baseViews.find((v) => v.xmlId === 'base_module.view_sale_order_form')!;
    const patch = patchViews.find((v) => v.xmlId === 'sale_extension.view_sale_order_form_priority')!;
    assert.ok(base && patch);

    const { effectiveArch, issues } = mergeViewChain(base, [patch]);
    assert.strictEqual(issues.length, 0);
    const fieldNames = findDescendants(effectiveArch!, 'field').map((f) => f.attributes.name);
    assert.ok(fieldNames.includes('priority'), 'priority field should be merged in after partner_id');
    const partnerIdx = fieldNames.indexOf('partner_id');
    const priorityIdx = fieldNames.indexOf('priority');
    assert.ok(priorityIdx === partnerIdx + 1, 'priority should be immediately after partner_id');
  });

  it('reports an issue when the xpath target does not exist', () => {
    const baseFile = path.join(FIXTURES_ROOT, 'base_module/views/sale_order_views.xml');
    const patchFile = path.join(FIXTURES_ROOT, 'custom_sale/views/sale_order_views.xml');

    const baseParsed = parseXml(baseFile, fs.readFileSync(baseFile, 'utf8'));
    const patchParsed = parseXml(patchFile, fs.readFileSync(patchFile, 'utf8'));
    const baseViews = extractViewRecords(baseParsed.root!, 'base_module', baseFile);
    const patchViews = extractViewRecords(patchParsed.root!, 'custom_sale', patchFile);

    const base = baseViews.find((v) => v.xmlId === 'base_module.view_sale_order_form')!;
    const badPatch = patchViews.find((v) => v.xmlId === 'custom_sale.view_sale_order_form_bad_xpath')!;
    assert.ok(base && badPatch);

    const { issues } = mergeViewChain(base, [badPatch]);
    assert.strictEqual(issues.length, 1);
    assert.match(issues[0].message, /was not found/);
  });
});

describe('AttributeLocator', () => {
  it('locates the exact value span of a field name attribute for a safe rename edit', () => {
    const file = path.join(FIXTURES_ROOT, 'base_module/views/sale_order_views.xml');
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split(/\r?\n/);
    const { root } = parseXml(file, source);
    const fields = findDescendants(root!, 'field');
    const partnerField = fields.find((f) => f.attributes.name === 'partner_id')!;
    assert.ok(partnerField);

    const loc = locateAttributeValue(lines, partnerField, 'name', 'partner_id');
    assert.ok(loc, 'expected to locate the partner_id attribute value');
    const extracted = lines[loc!.startLine].slice(loc!.startCol, loc!.endCol);
    assert.strictEqual(extracted, 'partner_id');
  });

  it('returns null when the node does not actually carry that attribute value', () => {
    const file = path.join(FIXTURES_ROOT, 'base_module/views/sale_order_views.xml');
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split(/\r?\n/);
    const { root } = parseXml(file, source);
    const fields = findDescendants(root!, 'field');
    const partnerField = fields.find((f) => f.attributes.name === 'partner_id')!;

    const loc = locateAttributeValue(lines, partnerField, 'name', 'does_not_exist');
    assert.strictEqual(loc, null);
  });
});

describe('RuleExtractor', () => {
  it('extracts an ir.rule record with resolved model, domain, and global flag', () => {
    const file = path.join(FIXTURES_ROOT, 'custom_sale/data/ir_rule.xml');
    const source = fs.readFileSync(file, 'utf8');
    const { root } = parseXml(file, source);
    const rules = extractRuleRecords(root!, 'custom_sale', file);
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].model, 'sale.order');
    assert.strictEqual(rules[0].domainForce, '[]');
    assert.strictEqual(rules[0].isGlobal, true);
    assert.strictEqual(rules[0].groups.length, 0);
  });
});

describe('AutomationRecordExtractor', () => {
  it('returns an empty list when a file has no ir.cron/ir.actions.server records', () => {
    const file = path.join(FIXTURES_ROOT, 'base_module/views/sale_order_views.xml');
    const source = fs.readFileSync(file, 'utf8');
    const { root } = parseXml(file, source);
    assert.deepStrictEqual(extractCronRecords(root!, 'base_module', file), []);
    assert.deepStrictEqual(extractServerActionRecords(root!, 'base_module', file), []);
  });
});
