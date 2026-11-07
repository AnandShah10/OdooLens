import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { JsonRpcRuntimeProvider } from '../../src/runtime/protocol/OdooRuntimeProvider';

interface SeenRequest {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/** A tiny stand-in for odoo-helper's controller: same paths, same bearer-token gate, same
 *  `database`-in-body contract, canned data. Lets the REAL client run over a REAL socket. */
function startFakeHelper(validToken: string): Promise<{ url: string; seen: SeenRequest[]; close: () => Promise<void> }> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ path: req.url ?? '', authorization: req.headers.authorization, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${validToken}`) return send(401, { error: 'unauthorized' });
      if (!body.database) return send(400, { error: 'missing "database"' });
      switch (req.url) {
        case '/odoolens/models':
          return send(200, ['res.partner', 'sale.order']);
        case '/odoolens/model':
          return send(200, body.model === 'sale.order' ? { name: 'sale.order', fields: ['name'], methods: ['action_confirm'], inheritedModules: ['sale'] } : null);
        case '/odoolens/field':
          return send(200, body.field === 'partner_id' ? { name: 'partner_id', type: 'many2one', comodel: 'res.partner', store: true, present: true } : null);
        case '/odoolens/views':
          return send(200, [{ id: 1, name: 'sale.order.form', type: 'form' }]);
        default:
          return send(404, { error: 'not found' });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('JsonRpcRuntimeProvider (against a fake odoo-helper endpoint)', () => {
  let helper: Awaited<ReturnType<typeof startFakeHelper>>;

  beforeEach(async () => {
    helper = await startFakeHelper('tok-123');
  });
  afterEach(async () => {
    await helper.close();
  });

  async function connected(token = 'tok-123'): Promise<JsonRpcRuntimeProvider> {
    const p = new JsonRpcRuntimeProvider();
    await p.connect({ serverUrl: helper.url + '/', database: 'devdb', authTokenSecretKey: 'k' }, token);
    return p;
  }

  it('is not connected until connect() is called, and refuses calls before then', async () => {
    const p = new JsonRpcRuntimeProvider();
    assert.strictEqual(p.isConnected(), false);
    await assert.rejects(() => p.getModels(), /not connected/);
  });

  it('getModels sends the bearer token and database, and returns the model list', async () => {
    const p = await connected();
    assert.deepStrictEqual(await p.getModels(), ['res.partner', 'sale.order']);
    assert.strictEqual(helper.seen[0].path, '/odoolens/models'); // trailing slash on serverUrl handled
    assert.strictEqual(helper.seen[0].authorization, 'Bearer tok-123');
    assert.strictEqual(helper.seen[0].body.database, 'devdb');
  });

  it('getModel returns the live model description, or null for an unknown model', async () => {
    const p = await connected();
    const info = await p.getModel('sale.order');
    assert.deepStrictEqual(info?.methods, ['action_confirm']);
    assert.strictEqual(await p.getModel('nope.model'), null);
  });

  it('getField and getViews pass their arguments through and return the helper payload', async () => {
    const p = await connected();
    const field = await p.getField('sale.order', 'partner_id');
    assert.strictEqual(field?.comodel, 'res.partner');
    assert.strictEqual(await p.getField('sale.order', 'missing'), null);
    assert.strictEqual((await p.getViews('sale.order'))[0].type, 'form');
    const fieldReq = helper.seen.find((r) => r.path === '/odoolens/field')!;
    assert.strictEqual(fieldReq.body.model, 'sale.order');
  });

  it('rejects with the HTTP status when the token is wrong', async () => {
    const p = await connected('wrong-token');
    await assert.rejects(() => p.getModels(), /HTTP 401/);
  });

  it('disconnect() returns it to the not-connected state', async () => {
    const p = await connected();
    await p.disconnect();
    assert.strictEqual(p.isConnected(), false);
    await assert.rejects(() => p.getModels(), /not connected/);
  });
});
