import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OdooWorkspaceIndex, NodeFsAdapter } from '../../src/index/OdooIndex';
import { runSecurityAnalyzer, SecurityRuleConfig } from '../../src/analyzer/security/SecurityAnalyzer';

const EXT_ROOT = path.resolve(__dirname, '../..');
const RULE = 'sudo-mutation-without-auth-check';

/** Indexes a one-file module whose model body is `methods`, and returns that file's findings. */
async function findingsFor(methods: string, config: SecurityRuleConfig = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoolens-auth-'));
  try {
    fs.mkdirSync(path.join(root, 'm/models'), { recursive: true });
    fs.writeFileSync(path.join(root, 'm/__manifest__.py'), "{'name': 'm', 'depends': []}");
    const file = path.join(root, 'm/models/t.py');
    fs.writeFileSync(
      file,
      `from odoo import models, fields, api\n\nclass T(models.Model):\n    _name = "t.thing"\n    name = fields.Char()\n\n${methods}`
    );
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([root]);
    return runSecurityAnalyzer(index.pythonFiles.get(file)!, config).filter((d) => d.ruleId === RULE);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const body = (extra = '') => `    def action_do(self):\n${extra}        self.sudo().write({'name': 'x'})\n`;

describe('sudo-mutation-without-auth-check', () => {
  it('flags a public method that uses sudo() and mutates with no access check', async () => {
    const f = await findingsFor(body());
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].confidence, 'low');
    assert.match(f[0].message, /action_do\(\)/);
    assert.match(f[0].message, /write\(\)/);
  });

  it('is satisfied by check_access()', async () => {
    assert.deepStrictEqual(await findingsFor(body("        self.check_access('write')\n")), []);
  });

  it('is satisfied by a group check (has_group / user_has_groups)', async () => {
    assert.deepStrictEqual(await findingsFor(body("        if not self.env.user.has_group('base.group_system'):\n            return\n")), []);
    assert.deepStrictEqual(await findingsFor(body("        self.user_has_groups('base.group_user')\n")), []);
  });

  it('exempts private (underscore) methods — not RPC-reachable', async () => {
    assert.deepStrictEqual(await findingsFor("    def _helper(self):\n        self.sudo().write({'name': 'x'})\n"), []);
  });

  it('exempts @api.private methods even without an underscore', async () => {
    assert.deepStrictEqual(await findingsFor("    @api.private\n    def action_do(self):\n        self.sudo().write({'name': 'x'})\n"), []);
  });

  it('exempts framework-invoked methods (@api.depends compute)', async () => {
    assert.deepStrictEqual(await findingsFor("    @api.depends('name')\n    def compute_x(self):\n        self.sudo().write({'name': 'x'})\n"), []);
  });

  it('does not flag sudo() without a mutation', async () => {
    assert.deepStrictEqual(await findingsFor("    def read_it(self):\n        return self.sudo().search([])\n"), []);
  });

  it('does not flag a mutation without sudo()', async () => {
    assert.deepStrictEqual(await findingsFor("    def action_do(self):\n        self.write({'name': 'x'})\n"), []);
  });

  it('can be disabled via configuration', async () => {
    assert.deepStrictEqual(await findingsFor(body(), { [RULE]: false }), []);
  });
});
