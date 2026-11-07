import * as assert from 'assert';
import { serializeIndexCache, deserializeIndexCache, CachedPythonEntry } from '../../src/index/IndexCache';
import { PythonFileAnalysis } from '../../src/parser/python/OdooModelExtractor';

function makeAnalysis(file: string): PythonFileAnalysis {
  return { file, modelContributions: [], controllerContributions: [], imports: [] };
}

describe('IndexCache', () => {
  it('round-trips a simple cache through serialize/deserialize', () => {
    const entries = new Map<string, CachedPythonEntry>([
      ['/tmp/a.py', { mtimeMs: 123, analysis: makeAnalysis('/tmp/a.py') }],
      ['/tmp/b.py', { mtimeMs: 456, analysis: makeAnalysis('/tmp/b.py') }],
    ]);
    const serialized = serializeIndexCache(entries);
    const restored = deserializeIndexCache(serialized);
    assert.ok(restored);
    assert.strictEqual(Object.keys(restored!.python).length, 2);
    assert.strictEqual(restored!.python['/tmp/a.py'].mtimeMs, 123);
    assert.strictEqual(restored!.python['/tmp/b.py'].analysis.file, '/tmp/b.py');
  });

  it('returns null for garbage input instead of throwing', () => {
    assert.strictEqual(deserializeIndexCache('not json at all {{{'), null);
    assert.strictEqual(deserializeIndexCache('null'), null);
    assert.strictEqual(deserializeIndexCache('42'), null);
    assert.strictEqual(deserializeIndexCache('{}'), null);
  });

  it('returns null for a cache written by a different (future or past) version', () => {
    const wrongVersion = JSON.stringify({ version: 999, python: {} });
    assert.strictEqual(deserializeIndexCache(wrongVersion), null);
  });
});
