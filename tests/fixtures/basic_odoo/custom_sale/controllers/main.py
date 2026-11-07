from odoo import http
from odoo.http import request


class CustomSaleController(http.Controller):

    @http.route('/custom_sale/confirm', type='http', auth='public', csrf=False)
    def confirm_order_publicly(self, order_id, **kwargs):
        # Deliberately risky fixture: public + no CSRF + sudo + mutation, to exercise the
        # widened, auth-aware security analyzer checks.
        order = request.env['sale.order'].sudo().browse(int(order_id))
        order.write({'state': 'sale'})
        return "ok"

    @http.route('/custom_sale/list', type='http', auth='user')
    def list_orders(self, **kwargs):
        orders = request.env['sale.order'].search([])
        return str(len(orders))

    @http.route('/custom_sale/bulk_lookup', type='http', auth='user')
    def bulk_lookup(self, partner_ids, **kwargs):
        # Intentional N+1 pattern inside a CONTROLLER method, to prove the ORM Doctor now
        # covers controller code, not just models.Model methods.
        results = []
        for pid in partner_ids:
            partner = request.env['res.partner'].search([('id', '=', pid)])
            results.append(partner)
        return str(results)
