import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseManifest } from '../../src/parser/manifest/ManifestParser';
import { discoverManifestFiles, loadModules, topologicalModuleOrder } from '../../src/index/ModuleIndex';

const EXT_ROOT = path.resolve(__dirname, '../..');
const FIXTURES_ROOT = path.join(EXT_ROOT, 'tests/fixtures/basic_odoo');

describe('ManifestParser', () => {
  it('parses depends/data/installable from a manifest dict literal', async () => {
    const file = path.join(FIXTURES_ROOT, 'sale_extension/__manifest__.py');
    const source = fs.readFileSync(file, 'utf8');
    const manifest = await parseManifest(file, source, EXT_ROOT);
    assert.ok(manifest);
    assert.strictEqual(manifest!.module, 'sale_extension');
    assert.deepStrictEqual(manifest!.depends, ['base_module']);
    assert.strictEqual(manifest!.installable, true);
    assert.deepStrictEqual(manifest!.data, ['views/sale_order_views.xml']);
  });
});

describe('ModuleIndex', () => {
  it('discovers all three fixture modules', () => {
    const files = discoverManifestFiles(FIXTURES_ROOT);
    assert.strictEqual(files.length, 3);
  });

  it('topologically orders modules so base_module precedes its dependents', async () => {
    const files = discoverManifestFiles(FIXTURES_ROOT);
    const modules = await loadModules(files, EXT_ROOT, (p) => fs.readFileSync(p, 'utf8'));
    const order = topologicalModuleOrder(modules);
    const idx = (name: string) => order.indexOf(name);
    assert.ok(idx('base_module') < idx('sale_extension'));
    assert.ok(idx('sale_extension') < idx('custom_sale'));
  });
});
