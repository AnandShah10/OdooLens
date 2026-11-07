import * as assert from 'assert';
import * as path from 'path';
import { OdooWorkspaceIndex, NodeFsAdapter } from '../../src/index/OdooIndex';
import { analyzeXmlFile, findDuplicateXmlIds } from '../../src/analyzer/xml/XmlAnalyzer';
import { runDeadCodeAnalyzer } from '../../src/analyzer/deadCode/DeadCodeAnalyzer';

const EXT_ROOT = path.resolve(__dirname, '../..');
const FIXTURES_ROOT = path.join(EXT_ROOT, 'tests/fixtures/basic_odoo');

describe('XmlAnalyzer', () => {
  it('flags a field reference that does not exist on the model', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const file = path.join(FIXTURES_ROOT, 'custom_sale/views/sale_order_views.xml');
    const xmlFile = index.xmlFiles.get(file)!;
    const diagnostics = analyzeXmlFile(index, xmlFile);
    const badField = diagnostics.find((d) => d.ruleId === 'xml-field-not-found');
    assert.ok(badField, 'expected xml-field-not-found for does_not_exist_field');
    assert.strictEqual(badField!.confidence, 'high');
  });

  it('flags an xpath target that does not exist in the inherited view', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const file = path.join(FIXTURES_ROOT, 'base_module/views/sale_order_views.xml');
    const xmlFile = index.xmlFiles.get(file)!;
    const diagnostics = analyzeXmlFile(index, xmlFile);
    assert.ok(diagnostics.some((d) => d.ruleId === 'xml-xpath-target-not-found'));
  });

  it('does not flag a valid field reference (partner_id) on a resolvable model', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const file = path.join(FIXTURES_ROOT, 'base_module/views/sale_order_views.xml');
    const xmlFile = index.xmlFiles.get(file)!;
    const diagnostics = analyzeXmlFile(index, xmlFile);
    const falsePositive = diagnostics.find((d) => d.ruleId === 'xml-field-not-found' && d.message.includes('partner_id'));
    assert.strictEqual(falsePositive, undefined);
  });

  it('detects no duplicate XML ids in the clean fixture set', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const dupes = findDuplicateXmlIds(index);
    assert.strictEqual(dupes.length, 0);
  });
});

describe('DeadCodeAnalyzer', () => {
  it('flags x_unused_flag as probably_unused at medium+ confidence', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const diagnostics = runDeadCodeAnalyzer(index, 'probably_unused');
    const finding = diagnostics.find((d) => d.message.includes('x_unused_flag'));
    assert.ok(finding, 'expected x_unused_flag to be flagged as dead code');
  });

  it('never flags name/state/active regardless of usage', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const diagnostics = runDeadCodeAnalyzer(index, 'unknown');
    assert.ok(!diagnostics.some((d) => d.message.includes('"name"')));
    assert.ok(!diagnostics.some((d) => d.message.includes('"state"')));
  });

  it('does not flag a field with statically-discovered XML usages (partner_id)', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const diagnostics = runDeadCodeAnalyzer(index, 'unknown');
    assert.ok(!diagnostics.some((d) => d.message.includes('"partner_id"')));
  });
});

describe('Report and QWeb extraction', () => {
  it('indexes ir.actions.report and template records from the fixture', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    assert.ok(index.reportRecords.length >= 1, 'expected at least one report');
    assert.ok(
      index.reportRecords.some((r) => r.xmlId.includes('action_report_custom_sale')),
      'expected action_report_custom_sale'
    );
    assert.ok(index.templateRecords.length >= 1, 'expected at least one template');
    assert.ok(
      index.templateRecords.some((t) => t.tName === 'custom_sale.report_sale_document'),
      'expected report_sale_document template'
    );
  });
});

describe('QwebAnalyzer', () => {
  it('flags unknown t-field on a report-bound template', async () => {
    const { analyzeQwebTemplates } = await import('../../src/analyzer/xml/QwebAnalyzer');
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const diagnostics = analyzeQwebTemplates(index);
    const bad = diagnostics.find((d) => d.ruleId === 'qweb-unknown-t-field');
    assert.ok(bad, 'expected qweb-unknown-t-field for x_nonexistent_field');
    assert.ok(bad!.message.includes('x_nonexistent_field'));
  });

  it('does not flag t-call to web.html_container as an error with high confidence', async () => {
    const { analyzeQwebTemplates } = await import('../../src/analyzer/xml/QwebAnalyzer');
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const diagnostics = analyzeQwebTemplates(index);
    const webCall = diagnostics.find(
      (d) => d.ruleId === 'qweb-unresolved-t-call' && d.message.includes('web.html_container')
    );
    assert.strictEqual(webCall, undefined, 'web.* t-calls should be skipped');
  });
});
