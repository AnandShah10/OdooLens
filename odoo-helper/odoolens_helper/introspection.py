"""Pure introspection logic for the OdooLens runtime helper.

Deliberately free of any `odoo` import at module level: every function takes an `env`-like
object (anything supporting `env[model_name]`, `env.registry`, ...) so the logic can be unit
tested with plain Python fakes — see odoo-helper/tests/test_introspection.py. The controller
in controllers/main.py is a thin shell that supplies a real Odoo environment.
"""
import hmac

TOKEN_PARAM = 'odoolens.api_token'


def check_token(provided, expected):
    """Constant-time bearer-token check. An empty/unset expected token ALWAYS fails, so the
    endpoints are disabled until an administrator deliberately sets `odoolens.api_token`."""
    if not expected or not provided:
        return False
    return hmac.compare_digest(str(provided).encode('utf-8'), str(expected).encode('utf-8'))


def list_models(env):
    return sorted(env.registry.models.keys())


def _public_methods(model_cls):
    names = []
    for name in dir(model_cls):
        if name.startswith('_'):
            continue
        # getattr on the CLASS, never an instance: instance access can trigger field/property
        # computation, and introspection must have no side effects.
        try:
            attr = getattr(model_cls, name, None)
        except Exception:  # pragma: no cover - defensive, descriptors can raise
            continue
        if callable(attr):
            names.append(name)
    return sorted(names)


def describe_model(env, model_name):
    """Returns {name, fields, methods, inheritedModules} or None if the model doesn't exist."""
    if model_name not in env.registry.models:
        return None
    model = env[model_name]
    modules = []
    try:
        # ir.model.modules is a comma-separated "which modules define this model" string.
        rec = env['ir.model'].sudo().search([('model', '=', model_name)], limit=1)
        if rec and rec.modules:
            modules = [m.strip() for m in rec.modules.split(',') if m.strip()]
    except Exception:  # pragma: no cover - older/newer schemas; module info is best-effort
        modules = []
    return {
        'name': model_name,
        'fields': sorted(model._fields.keys()),
        'methods': _public_methods(type(model)),
        'inheritedModules': modules,
    }


def describe_field(env, model_name, field_name):
    """Returns {name, type, comodel?, store, present: True} or None if model/field is absent."""
    if model_name not in env.registry.models:
        return None
    field = env[model_name]._fields.get(field_name)
    if field is None:
        return None
    info = {
        'name': field_name,
        'type': field.type,
        'store': bool(field.store),
        'present': True,
    }
    comodel = getattr(field, 'comodel_name', None)
    if comodel:
        info['comodel'] = comodel
    return info


def list_views(env, model_name):
    views = env['ir.ui.view'].sudo().search([('model', '=', model_name)])
    return [{'id': v.id, 'name': v.name, 'type': v.type} for v in views]
