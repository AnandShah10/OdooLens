import * as assert from 'assert';
import * as path from 'path';
import { OdooWorkspaceIndex, NodeFsAdapter } from '../../src/index/OdooIndex';
import { runAclAnalyzer } from '../../src/analyzer/security/AclAnalyzer';

const EXT_ROOT = path.resolve(__dirname, '../..');
const FIXTURES_ROOT = path.join(EXT_ROOT, 'tests/fixtures/basic_odoo');

describe('AclAnalyzer', () => {
  it('flags an access row referencing a model that does not exist anywhere in the workspace', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const diagnostics = runAclAnalyzer(index, {});
    const dangling = diagnostics.find((d) => d.ruleId === 'dangling-access-rule-model');
    assert.ok(dangling, 'expected a dangling-access-rule-model finding');
    assert.match(dangling!.message, /model_this_does_not_exist/);
  });

  it('flags an access row that grants write without read', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const diagnostics = runAclAnalyzer(index, {});
    const writeOnly = diagnostics.find((d) => d.ruleId === 'acl-write-without-read');
    assert.ok(writeOnly, 'expected an acl-write-without-read finding');
    assert.match(writeOnly!.message, /sale\.order\.writeonly/);
  });

  it('flags a model this workspace defines with zero access rows anywhere', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const diagnostics = runAclAnalyzer(index, {});
    const noAccess = diagnostics.find((d) => d.ruleId === 'no-access-rule-defined' && d.message.includes('custom_sale.log'));
    assert.ok(noAccess, 'expected custom_sale.log to be flagged for having no access rule');
  });

  it('does NOT flag res.partner for missing access rules (only ever _inherit-extended here, never _name-declared)', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const diagnostics = runAclAnalyzer(index, {});
    const falsePositive = diagnostics.find((d) => d.ruleId === 'no-access-rule-defined' && d.message.includes('res.partner'));
    assert.strictEqual(falsePositive, undefined, 'res.partner should not be flagged — its real _name declaration is outside this workspace');
  });

  it('does NOT flag sale.order for missing access rules (it has one)', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const diagnostics = runAclAnalyzer(index, {});
    const falsePositive = diagnostics.find((d) => d.ruleId === 'no-access-rule-defined' && d.message.includes('"sale.order"'));
    assert.strictEqual(falsePositive, undefined);
  });

  it('flags a global record rule with a trivial/empty domain', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const diagnostics = runAclAnalyzer(index, {});
    const permissive = diagnostics.find((d) => d.ruleId === 'permissive-record-rule');
    assert.ok(permissive, 'expected a permissive-record-rule finding');
    assert.match(permissive!.message, /overly permissive global rule/);
  });

  it('respects per-rule config toggles', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const diagnostics = runAclAnalyzer(index, { 'dangling-access-rule-model': false });
    assert.ok(!diagnostics.some((d) => d.ruleId === 'dangling-access-rule-model'));
  });
});
