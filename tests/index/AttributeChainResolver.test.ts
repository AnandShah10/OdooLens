import * as assert from 'assert';
import { resolveVarModel, resolveAttributeChain } from '../../src/index/AttributeChainResolver';
import { OdooModel, OdooFieldDecl, RawVarBinding } from '../../src/semantic/OdooTypes';

const LOC = { file: '/tmp/x.py', startLine: 0, startCol: 0, endLine: 0, endCol: 0 };

function makeField(name: string, model: string, comodel?: string): OdooFieldDecl {
  return {
    name,
    fieldType: comodel ? 'Many2one' : 'Char',
    comodel,
    dependsOn: [],
    model,
    module: 'test',
    location: LOC,
    nameLocation: LOC,
  };
}

function makeModel(name: string, fields: OdooFieldDecl[]): OdooModel {
  const m: OdooModel = {
    name,
    contributions: [],
    fields: new Map(fields.map((f) => [f.name, f])),
    fieldHistory: new Map(),
    methods: new Map(),
    methodHistory: new Map(),
    inheritsDelegated: {},
    modules: new Set(['test']),
    isAbstract: false,
    isTransient: false,
  };
  return m;
}

// sale.order.partner_id -> res.partner; res.partner.child_ids -> res.partner (self-referential,
// like Odoo's real res.partner.child_ids); res.partner.name is a plain Char (chain terminator).
const models = new Map<string, OdooModel>([
  ['sale.order', makeModel('sale.order', [makeField('partner_id', 'sale.order', 'res.partner')])],
  [
    'res.partner',
    makeModel('res.partner', [makeField('child_ids', 'res.partner', 'res.partner'), makeField('name', 'res.partner')]),
  ],
]);

describe('AttributeChainResolver.resolveVarModel', () => {
  it('resolves "self" directly against the provided selfModel', () => {
    const resolved = resolveVarModel('self', [], 'sale.order', models);
    assert.deepStrictEqual(resolved, { model: 'sale.order', confidence: 'high' });
  });

  it('resolves a forLoopOverChain binding through a relational field (multi-hop via for-loop)', () => {
    // for partner in self.partner_id: ...  (single-segment chain form)
    // for child in partner.child_ids: ...  (child: res.partner, self-referential)
    const bindings: RawVarBinding[] = [
      { varName: 'partner', source: { kind: 'forLoopOverChain', baseRef: 'self', fields: ['partner_id'], trailingMethods: [] } },
      { varName: 'child', source: { kind: 'forLoopOverChain', baseRef: 'partner', fields: ['child_ids'], trailingMethods: [] } },
    ];
    const resolved = resolveVarModel('child', bindings, 'sale.order', models);
    assert.ok(resolved);
    assert.strictEqual(resolved!.model, 'res.partner');
    assert.strictEqual(resolved!.confidence, 'low'); // downgraded twice: high -> medium -> low
  });

  it('resolves a chainRef binding (var = self.partner_id) to the comodel', () => {
    const bindings: RawVarBinding[] = [{ varName: 'p', source: { kind: 'chainRef', baseRef: 'self', fields: ['partner_id'], trailingMethods: [] } }];
    const resolved = resolveVarModel('p', bindings, 'sale.order', models);
    assert.deepStrictEqual(resolved, { model: 'res.partner', confidence: 'medium' });
  });

  it('returns null for a chainRef ending on a non-relational field', () => {
    const bindings: RawVarBinding[] = [{ varName: 'n', source: { kind: 'chainRef', baseRef: 'self', fields: ['partner_id', 'name'], trailingMethods: [] } }];
    // partner_id -> res.partner (ok), then .name is Char, not relational -> "n" has no model.
    const resolved = resolveVarModel('n', bindings, 'sale.order', models);
    assert.strictEqual(resolved, null);
  });

  it('returns null for an unresolvable variable rather than guessing', () => {
    const resolved = resolveVarModel('mystery_var', [], 'sale.order', models);
    assert.strictEqual(resolved, null);
  });

  it('resolves a for-loop over a MULTI-segment chain in one step (for x in a.b.c:)', () => {
    // for child in self.partner_id.child_ids:  — two field hops in a single iterable expression,
    // not two separate for-loops. This is the "for-loop iterable that's itself a multi-segment
    // chain" case.
    const bindings: RawVarBinding[] = [
      { varName: 'child', source: { kind: 'forLoopOverChain', baseRef: 'self', fields: ['partner_id', 'child_ids'], trailingMethods: [] } },
    ];
    const resolved = resolveVarModel('child', bindings, 'sale.order', models);
    assert.deepStrictEqual(resolved, { model: 'res.partner', confidence: 'low' }); // two hops: partner_id, then child_ids
  });

  it('preserves type through a known type-preserving method call (var = var.filtered(...))', () => {
    const bindings: RawVarBinding[] = [
      { varName: 'p', source: { kind: 'chainRef', baseRef: 'self', fields: ['partner_id'], trailingMethods: [] } },
      {
        varName: 'active_p',
        source: { kind: 'chainRef', baseRef: 'p', fields: [], trailingMethods: [{ name: 'filtered' }] },
      },
    ];
    const resolved = resolveVarModel('active_p', bindings, 'sale.order', models);
    // filtered() is type-preserving and does NOT add an extra confidence downgrade beyond what
    // resolving `p` itself already cost (medium, from the partner_id hop).
    assert.deepStrictEqual(resolved, { model: 'res.partner', confidence: 'medium' });
  });

  it('preserves type through a CHAIN of multiple type-preserving method calls (var.filtered(...).sorted(...))', () => {
    const bindings: RawVarBinding[] = [
      { varName: 'p', source: { kind: 'chainRef', baseRef: 'self', fields: ['partner_id'], trailingMethods: [] } },
      {
        varName: 'result',
        source: { kind: 'chainRef', baseRef: 'p', fields: [], trailingMethods: [{ name: 'filtered' }, { name: 'sorted' }, { name: 'exists' }] },
      },
    ];
    const resolved = resolveVarModel('result', bindings, 'sale.order', models);
    assert.deepStrictEqual(resolved, { model: 'res.partner', confidence: 'medium' });
  });

  it('resolves the model via mapped() with a single relational field-name argument', () => {
    const bindings: RawVarBinding[] = [
      {
        varName: 'children',
        source: { kind: 'chainRef', baseRef: 'self', fields: ['partner_id'], trailingMethods: [{ name: 'mapped', arg: 'child_ids' }] },
      },
    ];
    const resolved = resolveVarModel('children', bindings, 'sale.order', models);
    assert.deepStrictEqual(resolved, { model: 'res.partner', confidence: 'low' }); // two hops: partner_id, then mapped(child_ids)
  });

  it('does not guess a type for mapped() over a non-relational field', () => {
    const bindings: RawVarBinding[] = [
      {
        varName: 'names',
        source: { kind: 'chainRef', baseRef: 'self', fields: ['partner_id'], trailingMethods: [{ name: 'mapped', arg: 'name' }] },
      },
    ];
    // mapped('name') returns a plain list of strings, not a recordset — no model to resolve to.
    const resolved = resolveVarModel('names', bindings, 'sale.order', models);
    assert.strictEqual(resolved, null);
  });

  it('does not guess a type for an unrecognized method call', () => {
    const bindings: RawVarBinding[] = [
      { varName: 'p', source: { kind: 'chainRef', baseRef: 'self', fields: ['partner_id'], trailingMethods: [] } },
      { varName: 'weird', source: { kind: 'chainRef', baseRef: 'p', fields: [], trailingMethods: [{ name: 'some_custom_method' }] } },
    ];
    const resolved = resolveVarModel('weird', bindings, 'sale.order', models);
    assert.strictEqual(resolved, null);
  });

  it('does not guess a type when ANY method in a chain is unrecognized, even if others are known', () => {
    const bindings: RawVarBinding[] = [
      { varName: 'p', source: { kind: 'chainRef', baseRef: 'self', fields: ['partner_id'], trailingMethods: [] } },
      {
        varName: 'weird',
        source: { kind: 'chainRef', baseRef: 'p', fields: [], trailingMethods: [{ name: 'filtered' }, { name: 'some_custom_method' }, { name: 'sorted' }] },
      },
    ];
    const resolved = resolveVarModel('weird', bindings, 'sale.order', models);
    assert.strictEqual(resolved, null);
  });
});

describe('AttributeChainResolver.resolveAttributeChain', () => {
  it('walks a three-level chain, downgrading confidence at each hop, and stops at a terminal field', () => {
    const chain = {
      baseRef: 'self',
      segments: [
        { field: 'partner_id', location: LOC },
        { field: 'child_ids', location: LOC },
        { field: 'name', location: LOC },
      ],
    };
    const results = resolveAttributeChain(chain, 'sale.order', [], models);
    assert.strictEqual(results.length, 3);
    assert.deepStrictEqual(
      results.map((r) => [r.model, r.field, r.confidence]),
      [
        ['sale.order', 'partner_id', 'high'],
        ['res.partner', 'child_ids', 'medium'],
        ['res.partner', 'name', 'low'],
      ]
    );
  });

  it('returns an empty array when the base cannot be resolved at all', () => {
    const chain = { baseRef: 'nonexistent_var', segments: [{ field: 'name', location: LOC }] };
    const results = resolveAttributeChain(chain, 'sale.order', [], models);
    assert.deepStrictEqual(results, []);
  });
});
