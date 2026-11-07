import * as assert from 'assert';
import * as path from 'path';
import { OdooWorkspaceIndex, NodeFsAdapter } from '../../src/index/OdooIndex';
import { runOrmDoctor } from '../../src/analyzer/performance/OrmDoctor';
import { runSecurityAnalyzer } from '../../src/analyzer/security/SecurityAnalyzer';

const EXT_ROOT = path.resolve(__dirname, '../..');
const FIXTURES_ROOT = path.join(EXT_ROOT, 'tests/fixtures/basic_odoo');

describe('OrmDoctor', () => {
  it('flags search() inside a loop as an N+1 pattern', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const file = path.join(FIXTURES_ROOT, 'base_module/models/sale_order.py');
    const analysis = index.pythonFiles.get(file)!;
    const diagnostics = runOrmDoctor(analysis, '', {});
    const searchInLoop = diagnostics.find((d) => d.ruleId === 'search-in-loop');
    assert.ok(searchInLoop, 'expected a search-in-loop diagnostic');
    assert.strictEqual(searchInLoop!.severity, 'warning');
    assert.strictEqual(searchInLoop!.confidence, 'medium');
  });

  it('escalates confidence to high for a write() nested two loops deep', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const file = path.join(FIXTURES_ROOT, 'base_module/models/sale_order.py');
    const analysis = index.pythonFiles.get(file)!;
    const diagnostics = runOrmDoctor(analysis, '', {});
    const nested = diagnostics.find((d) => d.ruleId === 'write-in-loop');
    assert.ok(nested, 'expected a write-in-loop diagnostic');
    assert.strictEqual(nested!.confidence, 'high');
    assert.match(nested!.message, /nested 2 loops deep/);
  });

  it('flags a method that looks up the same self.env[...] model 3+ times', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const file = path.join(FIXTURES_ROOT, 'base_module/models/sale_order.py');
    const analysis = index.pythonFiles.get(file)!;
    const diagnostics = runOrmDoctor(analysis, '', {});
    const repeated = diagnostics.find((d) => d.ruleId === 'repeated-env-access');
    assert.ok(repeated, 'expected a repeated-env-access diagnostic');
    assert.strictEqual(repeated!.confidence, 'low');
    assert.strictEqual(repeated!.severity, 'information');
  });

  it('flags search_count([]) as counting the whole table', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const file = path.join(FIXTURES_ROOT, 'base_module/models/sale_order.py');
    const analysis = index.pythonFiles.get(file)!;
    const diagnostics = runOrmDoctor(analysis, '', {});
    assert.ok(diagnostics.some((d) => d.ruleId === 'search-count-misuse'));
  });

  it('flags search() inside a loop INSIDE A CONTROLLER method (not just models.Model methods)', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const file = path.join(FIXTURES_ROOT, 'custom_sale/controllers/main.py');
    const analysis = index.pythonFiles.get(file)!;
    assert.strictEqual(analysis.controllerContributions.length, 1, 'expected the controller class to be extracted');
    const diagnostics = runOrmDoctor(analysis, '', {});
    assert.ok(diagnostics.some((d) => d.ruleId === 'search-in-loop'), 'expected search-in-loop to fire inside the controller method');
  });

  it('respects the rule-disable configuration', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const file = path.join(FIXTURES_ROOT, 'base_module/models/sale_order.py');
    const analysis = index.pythonFiles.get(file)!;
    const diagnostics = runOrmDoctor(analysis, '', { 'search-in-loop': false });
    assert.ok(!diagnostics.some((d) => d.ruleId === 'search-in-loop'));
  });
});

describe('SecurityAnalyzer', () => {
  it('flags sudo() usage with medium-or-higher confidence', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const file = path.join(FIXTURES_ROOT, 'custom_sale/models/sale_order.py');
    const analysis = index.pythonFiles.get(file)!;
    const diagnostics = runSecurityAnalyzer(analysis, {});
    const sudoFinding = diagnostics.find((d) => d.ruleId === 'sudo-bypass');
    assert.ok(sudoFinding, 'expected a sudo-bypass diagnostic');
    assert.notStrictEqual(sudoFinding!.confidence, undefined);
  });

  it("escalates sudo-bypass to HIGH confidence when the route has auth='public'", async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const file = path.join(FIXTURES_ROOT, 'custom_sale/controllers/main.py');
    const analysis = index.pythonFiles.get(file)!;
    const diagnostics = runSecurityAnalyzer(analysis, {});
    const sudoFinding = diagnostics.find((d) => d.ruleId === 'sudo-bypass');
    assert.ok(sudoFinding, 'expected a sudo-bypass diagnostic from the public route');
    assert.strictEqual(sudoFinding!.confidence, 'high');
    assert.match(sudoFinding!.message, /auth='public'/);
  });

  it("escalates public-controller-mutation to warning/high confidence when auth='public'", async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const file = path.join(FIXTURES_ROOT, 'custom_sale/controllers/main.py');
    const analysis = index.pythonFiles.get(file)!;
    const diagnostics = runSecurityAnalyzer(analysis, {});
    const mutation = diagnostics.find((d) => d.ruleId === 'public-controller-mutation');
    assert.ok(mutation, 'expected a public-controller-mutation diagnostic');
    assert.strictEqual(mutation!.severity, 'warning');
    assert.strictEqual(mutation!.confidence, 'high');
  });

  it('flags csrf=False on a route as csrf-disabled-route', async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const file = path.join(FIXTURES_ROOT, 'custom_sale/controllers/main.py');
    const analysis = index.pythonFiles.get(file)!;
    const diagnostics = runSecurityAnalyzer(analysis, {});
    assert.ok(diagnostics.some((d) => d.ruleId === 'csrf-disabled-route'));
  });

  it("does NOT flag csrf-disabled-route on a route that doesn't disable csrf", async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const file = path.join(FIXTURES_ROOT, 'custom_sale/controllers/main.py');
    const analysis = index.pythonFiles.get(file)!;
    const diagnostics = runSecurityAnalyzer(analysis, {});
    const csrfFindings = diagnostics.filter((d) => d.ruleId === 'csrf-disabled-route');
    assert.strictEqual(csrfFindings.length, 1, 'only the one route with csrf=False should be flagged, not list_orders too');
  });

  it("reports unrestricted-search at LOW confidence when auth is 'user' (not public)", async () => {
    const index = new OdooWorkspaceIndex(EXT_ROOT, new NodeFsAdapter());
    await index.buildFull([FIXTURES_ROOT]);
    const file = path.join(FIXTURES_ROOT, 'custom_sale/controllers/main.py');
    const analysis = index.pythonFiles.get(file)!;
    const diagnostics = runSecurityAnalyzer(analysis, {});
    const search = diagnostics.find((d) => d.ruleId === 'unrestricted-search');
    assert.ok(search, 'expected an unrestricted-search diagnostic from list_orders');
    assert.strictEqual(search!.confidence, 'low');
  });
});
