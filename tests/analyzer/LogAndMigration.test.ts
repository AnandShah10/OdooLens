import * as assert from 'assert';
import { parseOdooLog, aggregateRecurringErrors } from '../../src/analyzer/logs/LogNavigator';
import { runMigrationAnalyzer } from '../../src/analyzer/migration/MigrationAnalyzer';
import { detectMajorVersion } from '../../src/versioning/MigrationRules';

const SAMPLE_LOG = `2026-01-01 10:00:00,000 ERROR my-db odoo.sql_db: bad query
Traceback (most recent call last):
  File "/odoo/addons/custom_sale/models/order.py", line 183, in action_confirm
    raise ValidationError("Cannot confirm without partner")
odoo.exceptions.ValidationError: Cannot confirm without partner

2026-01-01 10:05:00,000 ERROR my-db odoo.sql_db: bad query again
Traceback (most recent call last):
  File "/odoo/addons/custom_sale/models/order.py", line 183, in action_confirm
    raise ValidationError("Cannot confirm without partner")
odoo.exceptions.ValidationError: Cannot confirm without partner
`;

describe('LogNavigator', () => {
  it('parses tracebacks into structured errors with frames', () => {
    const errors = parseOdooLog(SAMPLE_LOG);
    assert.strictEqual(errors.length, 2);
    assert.strictEqual(errors[0].exceptionType, 'odoo.exceptions.ValidationError');
    assert.strictEqual(errors[0].frames.length, 1);
    assert.strictEqual(errors[0].frames[0].line, 183);
    assert.strictEqual(errors[0].frames[0].functionName, 'action_confirm');
  });

  it('aggregates recurring identical errors with a count', () => {
    const errors = parseOdooLog(SAMPLE_LOG);
    const aggregated = aggregateRecurringErrors(errors);
    assert.strictEqual(aggregated.length, 1);
    assert.strictEqual(aggregated[0].count, 2);
  });
});

describe('MigrationAnalyzer', () => {
  it('flags @api.multi when migrating from 14 to 15', () => {
    const source = 'class X(models.Model):\n    @api.multi\n    def foo(self):\n        pass\n';
    const findings = runMigrationAnalyzer('/tmp/x.py', source, '14', '15');
    assert.ok(findings.some((f) => f.rule.id === 'api-multi-removed'));
  });

  it('returns no findings for an up-to-date snippet', () => {
    const source = 'class X(models.Model):\n    def foo(self):\n        pass\n';
    const findings = runMigrationAnalyzer('/tmp/x.py', source, '14', '15');
    assert.strictEqual(findings.length, 0);
  });

  it('returns no rules when target <= source version', () => {
    const source = '@api.multi\n';
    const findings = runMigrationAnalyzer('/tmp/x.py', source, '16', '15');
    assert.strictEqual(findings.length, 0);
  });

  it('flags read_group() when migrating from 18 to 19', () => {
    const source = 'result = self.env["sale.order"].read_group([], ["amount_total"], ["state"])\n';
    const findings = runMigrationAnalyzer('/tmp/x.py', source, '18', '19');
    assert.ok(findings.some((f) => f.rule.id === 'read-group-deprecated'));
  });

  it('flags legacy odoo.osv imports when migrating from 18 to 19', () => {
    const source = 'from odoo.osv import expression\n';
    const findings = runMigrationAnalyzer('/tmp/x.py', source, '18', '19');
    assert.ok(findings.some((f) => f.rule.id === 'odoo-osv-import-deprecated'));
  });

  it('flags self._cr/_uid/_context access when migrating from 18 to 19', () => {
    const source = 'cr = self._cr\nuid = self._uid\nctx = self._context\n';
    const findings = runMigrationAnalyzer('/tmp/x.py', source, '18', '19');
    const matches = findings.filter((f) => f.rule.id === 'private-record-attrs-deprecated');
    assert.strictEqual(matches.length, 3, 'expected all three lines to be flagged');
  });

  it('flags check_access_rights()/check_access_rule() when migrating from 17 to 18', () => {
    const source = 'self.env["sale.order"].check_access_rights("read")\n';
    const findings = runMigrationAnalyzer('/tmp/x.py', source, '17', '18');
    assert.ok(findings.some((f) => f.rule.id === 'check-access-rights-rule-superseded'));
  });

  it('does not flag 18->19 rules when the version range does not include them', () => {
    const source = 'result = self.env["sale.order"].read_group([], [], [])\n';
    const findings = runMigrationAnalyzer('/tmp/x.py', source, '14', '15');
    assert.strictEqual(findings.length, 0);
  });

  it('flags args= renamed to domain= when migrating from 15 to 16', () => {
    const source = 'orders = self.env["sale.order"].search(args=[("state", "=", "sale")])\n';
    const findings = runMigrationAnalyzer('/tmp/x.py', source, '15', '16');
    assert.ok(findings.some((f) => f.rule.id === 'search-args-renamed-domain'));
  });

  it('flags fields_get_keys()/get_xml_id() and _mapped_cache() when migrating from 15 to 16', () => {
    const source = 'keys = self.fields_get_keys()\nxid = self.get_xml_id()\ncache = self._mapped_cache()\n';
    const findings = runMigrationAnalyzer('/tmp/x.py', source, '15', '16');
    assert.ok(findings.some((f) => f.rule.id === 'fields-get-keys-get-xml-id-deprecated'));
    assert.ok(findings.some((f) => f.rule.id === 'mapped-cache-removed'));
  });

  it('flags a removed _sequence Model attribute when migrating from 15 to 16', () => {
    const source = 'class SaleOrder(models.Model):\n    _sequence = "sale_order_seq"\n';
    const findings = runMigrationAnalyzer('/tmp/x.py', source, '15', '16');
    assert.ok(findings.some((f) => f.rule.id === 'model-sequence-attribute-removed'));
  });

  it('flags removed Field column_format/deprecated kwargs when migrating from 15 to 16', () => {
    const source = 'name = fields.Char(column_format="varchar")\n';
    const findings = runMigrationAnalyzer('/tmp/x.py', source, '15', '16');
    assert.ok(findings.some((f) => f.rule.id === 'field-column-format-deprecated-removed'));
  });

  it('does not flag 15->16 rules on unrelated code', () => {
    const source = 'name = fields.Char()\norders = self.env["sale.order"].search([])\n';
    const findings = runMigrationAnalyzer('/tmp/x.py', source, '15', '16');
    assert.strictEqual(findings.length, 0);
  });
});

describe('detectMajorVersion', () => {
  it('picks the most common leading major version across manifest version strings', () => {
    const detected = detectMajorVersion(['17.0.1.0.0', '17.0.2.1.0', '16.0.1.0.0']);
    assert.strictEqual(detected, '17');
  });

  it('returns undefined when no version string has a recognized major version', () => {
    const detected = detectMajorVersion(['1.0.0', undefined, 'not-a-version']);
    assert.strictEqual(detected, undefined);
  });

  it('returns undefined for an empty list', () => {
    assert.strictEqual(detectMajorVersion([]), undefined);
  });

  it('breaks ties by first-seen order (stable, not random)', () => {
    const detected = detectMajorVersion(['18.0.1.0.0', '17.0.1.0.0']);
    assert.strictEqual(detected, '18');
  });
});

describe('MigrationAnalyzer: XML rules and file-kind scoping', () => {
  const ids = (src: string, from: '16' | '17', to: '17' | '18', kind?: 'python' | 'xml') =>
    runMigrationAnalyzer('/tmp/x', src, from, to, kind).map((f) => f.rule.id);

  it('flags <tree> as the list view root tag when migrating 17 -> 18', () => {
    assert.ok(ids('<record><field name="arch" type="xml"><tree string="X">', '17', '18', 'xml').includes('xml-tree-tag-renamed-list'));
  });

  it('does not match tag names that merely start with "tree" (e.g. <tree_view_ref>)', () => {
    assert.ok(!ids('<tree_view_ref/>', '17', '18', 'xml').includes('xml-tree-tag-renamed-list'));
  });

  it('flags view_mode containing tree in XML actions, but not an already-migrated list,form', () => {
    assert.ok(ids('<field name="view_mode">tree,form</field>', '17', '18', 'xml').includes('xml-view-mode-tree-renamed-list'));
    assert.ok(!ids('<field name="view_mode">list,form</field>', '17', '18', 'xml').includes('xml-view-mode-tree-renamed-list'));
  });

  it("flags 'view_mode': 'tree,form' in a Python action dict, but not a migrated one", () => {
    assert.ok(ids("return {'type': 'ir.actions.act_window', 'view_mode': 'tree,form'}", '17', '18', 'python').includes('py-view-mode-tree-renamed-list'));
    assert.ok(!ids("return {'view_mode': 'list,form'}", '17', '18', 'python').includes('py-view-mode-tree-renamed-list'));
  });

  it('applies xml-category rules ONLY to XML and everything else ONLY to Python when a kind is given', () => {
    // An xml rule's pattern appearing in Python source must not fire...
    assert.deepStrictEqual(ids('x = "<tree>"', '17', '18', 'python'), []);
    // ...and a Python-only rule's pattern appearing in XML must not fire.
    assert.ok(!ids("<field name=\"x\">'view_mode': 'tree'</field>", '17', '18', 'xml').includes('py-view-mode-tree-renamed-list'));
  });

  it('REGRESSION: the attrs= view rule (category xml) can now fire on XML — it never could before', () => {
    const xml = `<field name="partner_id" attrs="{'invisible': [('state', '=', 'draft')]}"/>`;
    assert.ok(ids(xml, '16', '17', 'xml').includes('attrs-states-deprecated-views'));
    // And with the old Python-only scan (kind='python') it is correctly NOT applied.
    assert.ok(!ids(xml, '16', '17', 'python').includes('attrs-states-deprecated-views'));
  });

  it('without a kind, all rules apply (back-compat for callers that do not distinguish)', () => {
    assert.ok(ids('<tree>', '17', '18').includes('xml-tree-tag-renamed-list'));
  });
});
