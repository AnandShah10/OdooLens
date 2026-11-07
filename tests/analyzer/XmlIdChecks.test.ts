import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OdooWorkspaceIndex, NodeFsAdapter } from '../../src/index/OdooIndex';
import { findDuplicateXmlIds, findUnresolvedXmlRefs } from '../../src/analyzer/xml/XmlAnalyzer';

const EXT_ROOT = path.resolve(__dirname, '../..');

/** Builds a throwaway workspace from {relativePath: content} and indexes it. */
async function indexFiles(files: Record<string, string>): Promise<{ index: OdooWorkspaceIndex; cleanup: () => void }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoolens-xmlid-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
  await index.buildFull([root]);
  return { index, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const view = (id: string, model = 'x.thing') =>
  `<record id="${id}" model="ir.ui.view"><field name="name">${id}</field><field name="model">${model}</field>` +
  `<field name="arch" type="xml"><form><field name="name"/></form></field></record>`;

describe('findDuplicateXmlIds', () => {
  it('flags the same view id declared twice (across two files in one module)', async () => {
    const { index, cleanup } = await indexFiles({
      'm/__manifest__.py': "{'name': 'm', 'depends': []}",
      'm/views/a.xml': `<odoo>${view('dup_view')}</odoo>`,
      'm/views/b.xml': `<odoo>${view('dup_view')}</odoo>`,
    });
    try {
      const dupes = findDuplicateXmlIds(index);
      assert.ok(dupes.length >= 2, `expected a finding on each declaration, got ${dupes.length}`);
      assert.ok(dupes.every((d) => d.ruleId === 'xml-duplicate-id'));
    } finally {
      cleanup();
    }
  });

  it('also catches duplicates of non-view records (e.g. two ir.rule/menuitem ids)', async () => {
    const { index, cleanup } = await indexFiles({
      'm/__manifest__.py': "{'name': 'm', 'depends': []}",
      'm/data/a.xml': '<odoo><menuitem id="menu_x" name="A"/></odoo>',
      'm/data/b.xml': '<odoo><menuitem id="menu_x" name="B"/></odoo>',
    });
    try {
      assert.ok(findDuplicateXmlIds(index).length >= 2);
    } finally {
      cleanup();
    }
  });

  it('does not flag the same local id in two DIFFERENT modules (they are m1.x and m2.x)', async () => {
    const { index, cleanup } = await indexFiles({
      'm1/__manifest__.py': "{'name': 'm1', 'depends': []}",
      'm1/views/a.xml': `<odoo>${view('same_local_id')}</odoo>`,
      'm2/__manifest__.py': "{'name': 'm2', 'depends': []}",
      'm2/views/a.xml': `<odoo>${view('same_local_id')}</odoo>`,
    });
    try {
      assert.strictEqual(findDuplicateXmlIds(index).length, 0);
    } finally {
      cleanup();
    }
  });
});

const MANIFEST = "{'name': 'm', 'depends': []}";
const rec = (id: string, extra = '') => `<record id="${id}" model="res.partner"><field name="name">x</field>${extra}</record>`;

async function unresolved(files: Record<string, string>) {
  const { index, cleanup } = await indexFiles({ 'm/__manifest__.py': MANIFEST, ...files });
  try {
    return findUnresolvedXmlRefs(index);
  } finally {
    cleanup();
  }
}

describe('findUnresolvedXmlRefs', () => {
  it('flags a qualified ref into a workspace module whose id is never declared', async () => {
    const d = await unresolved({ 'm/data/a.xml': `<odoo>${rec('a', '<field name="parent_id" ref="m.missing"/>')}</odoo>` });
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].ruleId, 'xml-unresolved-ref');
    assert.match(d[0].message, /"m\.missing"/);
  });

  it('treats a bare ref as belonging to the current module', async () => {
    const d = await unresolved({ 'm/data/a.xml': `<odoo>${rec('a', '<field name="parent_id" ref="missing"/>')}</odoo>` });
    assert.strictEqual(d.length, 1);
  });

  it('does not flag a ref whose id is declared in another file of the module', async () => {
    const d = await unresolved({
      'm/data/a.xml': `<odoo>${rec('a', '<field name="parent_id" ref="b"/>')}</odoo>`,
      'm/data/b.xml': `<odoo>${rec('b')}</odoo>`,
    });
    assert.deepStrictEqual(d, []);
  });

  it('does not judge refs into modules outside the workspace (e.g. base.group_user)', async () => {
    const d = await unresolved({ 'm/data/a.xml': `<odoo>${rec('a', '<field name="groups_id" ref="base.group_user"/>')}</odoo>` });
    assert.deepStrictEqual(d, []);
  });

  it('never flags ORM-generated ids (model_*, field_*) that no XML file declares', async () => {
    const d = await unresolved({
      'm/data/a.xml': `<odoo>${rec('a', '<field name="model_id" ref="model_res_partner"/><field name="f" ref="field_res_partner__name"/>')}</odoo>`,
    });
    assert.deepStrictEqual(d, []);
  });

  it('resolves ids declared by an ir.model.access.csv row', async () => {
    const d = await unresolved({
      'm/security/ir.model.access.csv': 'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\naccess_thing,thing,model_res_partner,,1,0,0,0\n',
      'm/data/a.xml': `<odoo>${rec('a', '<field name="x" ref="access_thing"/>')}</odoo>`,
    });
    assert.deepStrictEqual(d, []);
  });

  it('checks menuitem action/parent, flagging only the missing one', async () => {
    const d = await unresolved({
      'm/data/a.xml': '<odoo><menuitem id="root" name="Root"/><menuitem id="child" name="C" parent="root" action="no_such_action"/></odoo>',
    });
    assert.strictEqual(d.length, 1);
    assert.match(d[0].message, /menuitem-action/);
  });

  it("checks refs inside eval=\"ref('...')\" expressions", async () => {
    const d = await unresolved({ 'm/data/a.xml': `<odoo>${rec('a', `<field name="x" eval="[(4, ref('m.gone'))]"/>`)}</odoo>` });
    assert.strictEqual(d.length, 1);
    assert.match(d[0].message, /eval-ref/);
  });

  it('checks <button type="action" name="module.id"> inside a view arch, ignoring raw numeric ids', async () => {
    const arch = (name: string) =>
      `<record id="v${name.replace(/\W/g, '')}" model="ir.ui.view"><field name="model">res.partner</field>` +
      `<field name="arch" type="xml"><form><button type="action" name="${name}"/></form></field></record>`;
    const d = await unresolved({ 'm/views/a.xml': `<odoo>${arch('m.gone_action')}${arch('123')}</odoo>` });
    assert.strictEqual(d.length, 1);
    assert.match(d[0].message, /button-action/);
  });

  it('does not double-report a missing inherit_id (that has its own rule)', async () => {
    const d = await unresolved({
      'm/views/a.xml': '<odoo><record id="v" model="ir.ui.view"><field name="model">res.partner</field><field name="inherit_id" ref="m.no_parent"/><field name="arch" type="xml"><form/></field></record></odoo>',
    });
    assert.deepStrictEqual(d, []);
  });
});
