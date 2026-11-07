"""Plain-unittest tests for odoolens_helper.introspection using fakes (no Odoo required).

Run from the odoo-helper directory:  python3 -m unittest discover -s tests -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'odoolens_helper'))
import introspection  # noqa: E402


class FakeField:
    def __init__(self, type_, store=True, comodel_name=None):
        self.type = type_
        self.store = store
        self.comodel_name = comodel_name


class FakeSaleOrder:
    _fields = {
        'name': FakeField('char'),
        'partner_id': FakeField('many2one', comodel_name='res.partner'),
        'amount_total': FakeField('monetary', store=False),
    }

    def action_confirm(self):
        pass

    def _compute_amount_total(self):  # private: must be excluded
        pass

    some_attribute = 42  # not callable: must be excluded


class FakeIrModelRecord:
    def __init__(self, modules):
        self.modules = modules

    def __bool__(self):
        return True


class FakeEmptyRecordset:
    """An empty recordset: falsy, like real Odoo."""

    modules = False

    def __bool__(self):
        return False


class FakeView:
    def __init__(self, id_, name, type_):
        self.id, self.name, self.type = id_, name, type_


class FakeModelProxy:
    """Stands in for env['ir.model'] / env['ir.ui.view'] (supports .sudo().search(...))."""

    def __init__(self, results):
        self._results = results

    def sudo(self):
        return self

    def search(self, domain, limit=None):
        return self._results


class FakeEnv:
    class registry:  # noqa: N801 - mimics env.registry attribute
        models = {'sale.order': FakeSaleOrder, 'res.partner': object}

    def __init__(self, ir_model_modules='base, sale', views=()):
        self._ir_model_modules = ir_model_modules
        self._views = list(views)

    def __getitem__(self, name):
        if name == 'sale.order':
            return FakeSaleOrder()
        if name == 'ir.model':
            # search(..., limit=1) returns a SINGLETON recordset (attribute access works directly),
            # or an empty falsy one — not a Python list.
            return FakeModelProxy(
                FakeIrModelRecord(self._ir_model_modules) if self._ir_model_modules is not None else FakeEmptyRecordset()
            )
        if name == 'ir.ui.view':
            return FakeModelProxy(self._views)
        raise KeyError(name)


class TokenTests(unittest.TestCase):
    def test_matching_token_passes(self):
        self.assertTrue(introspection.check_token('s3cret', 's3cret'))

    def test_wrong_token_fails(self):
        self.assertFalse(introspection.check_token('nope', 's3cret'))

    def test_unset_expected_token_always_fails(self):
        # The "disabled until configured" guarantee: even an empty bearer must not pass.
        self.assertFalse(introspection.check_token('', ''))
        self.assertFalse(introspection.check_token('anything', None))
        self.assertFalse(introspection.check_token('anything', False))

    def test_missing_provided_token_fails(self):
        self.assertFalse(introspection.check_token('', 's3cret'))
        self.assertFalse(introspection.check_token(None, 's3cret'))


class IntrospectionTests(unittest.TestCase):
    def test_list_models_is_sorted(self):
        self.assertEqual(introspection.list_models(FakeEnv()), ['res.partner', 'sale.order'])

    def test_describe_model_fields_methods_and_modules(self):
        info = introspection.describe_model(FakeEnv(), 'sale.order')
        self.assertEqual(info['name'], 'sale.order')
        self.assertEqual(info['fields'], ['amount_total', 'name', 'partner_id'])
        self.assertEqual(info['methods'], ['action_confirm'])  # no private, no non-callables
        self.assertEqual(info['inheritedModules'], ['base', 'sale'])

    def test_describe_model_unknown_returns_none(self):
        self.assertIsNone(introspection.describe_model(FakeEnv(), 'does.not.exist'))

    def test_describe_model_without_ir_model_row_has_no_modules(self):
        info = introspection.describe_model(FakeEnv(ir_model_modules=None), 'sale.order')
        self.assertEqual(info['inheritedModules'], [])

    def test_describe_field_relational(self):
        info = introspection.describe_field(FakeEnv(), 'sale.order', 'partner_id')
        self.assertEqual(info, {'name': 'partner_id', 'type': 'many2one', 'store': True, 'present': True, 'comodel': 'res.partner'})

    def test_describe_field_non_stored_has_no_comodel_key(self):
        info = introspection.describe_field(FakeEnv(), 'sale.order', 'amount_total')
        self.assertFalse(info['store'])
        self.assertNotIn('comodel', info)

    def test_describe_field_missing_returns_none(self):
        self.assertIsNone(introspection.describe_field(FakeEnv(), 'sale.order', 'nope'))
        self.assertIsNone(introspection.describe_field(FakeEnv(), 'nope.model', 'name'))

    def test_list_views(self):
        env = FakeEnv(views=[FakeView(7, 'sale.order.form', 'form'), FakeView(9, 'sale.order.tree', 'tree')])
        self.assertEqual(
            introspection.list_views(env, 'sale.order'),
            [{'id': 7, 'name': 'sale.order.form', 'type': 'form'}, {'id': 9, 'name': 'sale.order.tree', 'type': 'tree'}],
        )


if __name__ == '__main__':
    unittest.main()
