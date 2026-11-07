import json
import logging

import odoo
from odoo import SUPERUSER_ID, api, http
from odoo.http import request

from .. import introspection

_logger = logging.getLogger(__name__)


class OdooLensController(http.Controller):
    """Read-only introspection endpoints consumed by the OdooLens VS Code extension.

    auth='none' + a per-request registry lookup is used (rather than a user session) so the
    extension can authenticate with a single bearer token instead of an Odoo login. Access is
    gated entirely by the `odoolens.api_token` system parameter: unset -> every request is
    refused. All handlers are strictly read-only.
    """

    def _respond(self, payload, status=200):
        return request.make_response(
            json.dumps(payload),
            headers=[('Content-Type', 'application/json')],
            status=status,
        )

    def _handle(self, fn):
        """Common auth + environment setup. `fn(env, body)` returns a JSON-serializable value."""
        try:
            body = json.loads(request.httprequest.get_data() or b'{}')
        except ValueError:
            return self._respond({'error': 'invalid JSON body'}, 400)
        db = body.get('database')
        if not db or not isinstance(db, str):
            return self._respond({'error': 'missing "database"'}, 400)

        auth_header = request.httprequest.headers.get('Authorization', '')
        provided = auth_header[len('Bearer '):] if auth_header.startswith('Bearer ') else ''

        try:
            registry = odoo.registry(db)
            with registry.cursor() as cr:
                env = api.Environment(cr, SUPERUSER_ID, {})
                expected = env['ir.config_parameter'].sudo().get_param(introspection.TOKEN_PARAM)
                if not introspection.check_token(provided, expected):
                    return self._respond({'error': 'unauthorized'}, 401)
                return self._respond(fn(env, body))
        except Exception:  # noqa: BLE001 - never leak internals to the caller
            _logger.exception('OdooLens helper request failed')
            return self._respond({'error': 'internal error'}, 500)

    @http.route('/odoolens/models', type='http', auth='none', methods=['POST'], csrf=False)
    def models(self, **_kw):
        return self._handle(lambda env, body: introspection.list_models(env))

    @http.route('/odoolens/model', type='http', auth='none', methods=['POST'], csrf=False)
    def model(self, **_kw):
        return self._handle(lambda env, body: introspection.describe_model(env, body.get('model', '')))

    @http.route('/odoolens/field', type='http', auth='none', methods=['POST'], csrf=False)
    def field(self, **_kw):
        return self._handle(
            lambda env, body: introspection.describe_field(env, body.get('model', ''), body.get('field', ''))
        )

    @http.route('/odoolens/views', type='http', auth='none', methods=['POST'], csrf=False)
    def views(self, **_kw):
        return self._handle(lambda env, body: introspection.list_views(env, body.get('model', '')))
