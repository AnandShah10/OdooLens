import * as assert from 'assert';
import * as path from 'path';
import { OdooWorkspaceIndex, NodeFsAdapter } from '../../src/index/OdooIndex';
import { buildModelTreeRoots, buildModuleTreeRoots, buildProblemsTreeRoots } from '../../src/views/TreeData';
import { OdooDiagnostic } from '../../src/semantic/OdooTypes';

const EXT_ROOT = path.resolve(__dirname, '../..');
const FIXTURES_ROOT = path.join(EXT_ROOT, 'tests/fixtures/basic_odoo');

async function buildFixtureIndex(): Promise<OdooWorkspaceIndex> {
  const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
  await index.buildFull([FIXTURES_ROOT]);
  return index;
}

function makeDiagnostic(overrides: Partial<OdooDiagnostic>): OdooDiagnostic {
  return {
    ruleId: 'test-rule',
    message: 'test message',
    severity: 'warning',
    confidence: 'medium',
    location: { file: '/tmp/a.py', startLine: 4, startCol: 0, endLine: 4, endCol: 1 },
    category: 'performance',
    fixes: [],
    ...overrides,
  };
}

describe('TreeData.buildModelTreeRoots', () => {
  it('produces one root per indexed model, alphabetically sorted', async () => {
    const index = await buildFixtureIndex();
    const roots = buildModelTreeRoots(index);
    const labels = roots.map((r) => r.label);
    assert.ok(labels.includes('sale.order'));
    assert.ok(labels.includes('res.partner'));
    assert.deepStrictEqual(labels, [...labels].sort());
  });

  it('nests Fields and Methods categories under each model with real counts and locations', async () => {
    const index = await buildFixtureIndex();
    const saleOrder = buildModelTreeRoots(index).find((r) => r.label === 'sale.order')!;
    assert.ok(saleOrder.children);
    const fieldsCat = saleOrder.children!.find((c) => c.label.startsWith('Fields'));
    const methodsCat = saleOrder.children!.find((c) => c.label.startsWith('Methods'));
    assert.ok(fieldsCat && methodsCat);

    const partnerId = fieldsCat!.children!.find((f) => f.label === 'partner_id')!;
    assert.ok(partnerId);
    assert.match(partnerId.description!, /Many2one → res\.partner/);
    assert.ok(partnerId.location, 'clicking a field node should have somewhere to jump to');

    const actionConfirm = methodsCat!.children!.find((m) => m.label === 'action_confirm()')!;
    assert.ok(actionConfirm);
    assert.ok(actionConfirm.location);
  });

  it('shows contributing modules in the model node tooltip', async () => {
    const index = await buildFixtureIndex();
    const saleOrder = buildModelTreeRoots(index).find((r) => r.label === 'sale.order')!;
    assert.match(saleOrder.tooltip!, /base_module/);
    assert.match(saleOrder.tooltip!, /custom_sale/);
  });
});

describe('TreeData.buildModuleTreeRoots', () => {
  it('lists modules in dependency order (base before dependents)', async () => {
    const index = await buildFixtureIndex();
    const labels = buildModuleTreeRoots(index).map((r) => r.label);
    assert.ok(labels.indexOf('base_module') < labels.indexOf('sale_extension'));
    assert.ok(labels.indexOf('sale_extension') < labels.indexOf('custom_sale'));
  });

  it('nests the models each module contributes to, and the modules it depends on', async () => {
    const index = await buildFixtureIndex();
    const custom = buildModuleTreeRoots(index).find((r) => r.label === 'custom_sale')!;
    const modelsCat = custom.children!.find((c) => c.label.startsWith('Models'))!;
    const modelLabels = modelsCat.children!.map((c) => c.label);
    assert.ok(modelLabels.includes('sale.order'));
    assert.ok(modelLabels.includes('custom_sale.log'));

    const dependsCat = custom.children!.find((c) => c.label.startsWith('Depends on'))!;
    assert.deepStrictEqual(
      dependsCat.children!.map((c) => c.label),
      ['sale_extension']
    );
  });

  it('marks dependencies that are not present in the workspace', async () => {
    const index = await buildFixtureIndex();
    const base = buildModuleTreeRoots(index).find((r) => r.label === 'base_module')!;
    const dependsCat = base.children!.find((c) => c.label.startsWith('Depends on'))!;
    const baseDep = dependsCat.children!.find((c) => c.label === 'base')!;
    assert.strictEqual(baseDep.description, '(not in workspace)');
  });
});

describe('TreeData.buildProblemsTreeRoots', () => {
  it('groups diagnostics by category with security first', () => {
    const roots = buildProblemsTreeRoots([
      makeDiagnostic({ category: 'performance', ruleId: 'search-in-loop' }),
      makeDiagnostic({ category: 'security', ruleId: 'sudo-bypass' }),
      makeDiagnostic({ category: 'xml', ruleId: 'xml-field-not-found' }),
    ]);
    assert.strictEqual(roots[0].label, 'Security (1)');
    assert.strictEqual(roots[1].label, 'Performance (1)');
    assert.strictEqual(roots[2].label, 'XML (1)');
  });

  it('omits categories with no diagnostics entirely', () => {
    const roots = buildProblemsTreeRoots([makeDiagnostic({ category: 'security' })]);
    assert.strictEqual(roots.length, 1);
  });

  it('returns an empty list when there are no diagnostics at all', () => {
    assert.deepStrictEqual(buildProblemsTreeRoots([]), []);
  });

  it('gives each problem a location and a tooltip including its confidence', () => {
    const roots = buildProblemsTreeRoots([makeDiagnostic({ category: 'security', confidence: 'high', message: 'bad thing' })]);
    const problem = roots[0].children![0];
    assert.ok(problem.location);
    assert.match(problem.tooltip!, /bad thing/);
    assert.match(problem.tooltip!, /high confidence/);
  });

  it('sorts problems within a category by file then line', () => {
    const roots = buildProblemsTreeRoots([
      makeDiagnostic({ category: 'security', location: { file: '/tmp/b.py', startLine: 1, startCol: 0, endLine: 1, endCol: 1 } }),
      makeDiagnostic({ category: 'security', location: { file: '/tmp/a.py', startLine: 9, startCol: 0, endLine: 9, endCol: 1 } }),
      makeDiagnostic({ category: 'security', location: { file: '/tmp/a.py', startLine: 2, startCol: 0, endLine: 2, endCol: 1 } }),
    ]);
    const descriptions = roots[0].children!.map((c) => c.description);
    assert.deepStrictEqual(descriptions, ['tmp/a.py:3', 'tmp/a.py:10', 'tmp/b.py:2']);
  });
});
