import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OdooWorkspaceIndex, NodeFsAdapter } from '../../src/index/OdooIndex';

const EXT_ROOT = path.resolve(__dirname, '../..');
const FIXTURES_ROOT = path.join(EXT_ROOT, 'tests/fixtures/basic_odoo');

/** A throwaway module with `fileCount` tiny model files — enough to cross the yield interval. */
function makeSyntheticModule(fileCount: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoolens-synth-'));
  const mod = path.join(root, 'synth_mod');
  fs.mkdirSync(path.join(mod, 'models'), { recursive: true });
  fs.writeFileSync(path.join(mod, '__manifest__.py'), "{'name': 'synth', 'depends': [], 'version': '17.0.1.0.0'}\n");
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(
      path.join(mod, 'models', `m${i}.py`),
      `from odoo import models, fields\n\nclass M${i}(models.Model):\n    _name = "synth.m${i}"\n    name = fields.Char()\n`
    );
  }
  return root;
}

describe('OdooWorkspaceIndex cancellation and yielding', () => {
  it('reports cancelled=false for a normal build', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    const stats = await index.buildFull([FIXTURES_ROOT]);
    assert.strictEqual(stats.cancelled, false);
  });

  it('stops before parsing anything when cancelled immediately, leaving a consistent (empty) index', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    const stats = await index.buildFull([FIXTURES_ROOT], { isCancelled: () => true });
    assert.strictEqual(stats.cancelled, true);
    assert.strictEqual(stats.pythonFileCount, 0);
    assert.strictEqual(index.models.size, 0);
    // Modules were discovered before the file loop, so the module list is still usable.
    assert.strictEqual(index.modules.size, 3);
  });

  it('stops partway through, keeping what was parsed and merging models from it', async () => {
    const full = await new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter()).buildFull([FIXTURES_ROOT]);
    let polls = 0;
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    const stats = await index.buildFull([FIXTURES_ROOT], { isCancelled: () => ++polls > 3 });
    assert.strictEqual(stats.cancelled, true);
    assert.ok(stats.pythonFileCount > 0 && stats.pythonFileCount < full.pythonFileCount, `got ${stats.pythonFileCount} of ${full.pythonFileCount}`);
    assert.ok(index.models.size > 0, 'models should be merged from the files that were parsed');
  });

  it('does not lose previously-cached entries when a later build is cancelled', async () => {
    const cacheFile = path.join(os.tmpdir(), `odoolens-cancel-cache-${Date.now()}.json`);
    try {
      const first = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
      first.cacheFilePath = cacheFile;
      const firstStats = await first.buildFull([FIXTURES_ROOT]);

      const cancelledBuild = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
      cancelledBuild.cacheFilePath = cacheFile;
      await cancelledBuild.buildFull([FIXTURES_ROOT], { isCancelled: () => true });

      const third = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
      third.cacheFilePath = cacheFile;
      const thirdStats = await third.buildFull([FIXTURES_ROOT]);
      assert.strictEqual(thirdStats.pythonCacheHitCount, firstStats.pythonFileCount, 'cancelling must not wipe the cache');
    } finally {
      fs.rmSync(cacheFile, { force: true });
    }
  });

  it('yields to the event loop during a large build (a timer can fire mid-build)', async () => {
    const root = makeSyntheticModule(80); // > 3x the yield interval
    try {
      await new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter()).buildFull([root]); // pre-warm the WASM parser
      let timerFired = false;
      setTimeout(() => (timerFired = true), 0);
      let sawTimerMidBuild = false;
      const stats = await new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter()).buildFull([root], {
        isCancelled: () => {
          if (timerFired) sawTimerMidBuild = true;
          return false;
        },
      });
      assert.strictEqual(stats.pythonFileCount, 80);
      assert.ok(sawTimerMidBuild, 'the event loop never turned during the build — it would freeze the extension host');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
