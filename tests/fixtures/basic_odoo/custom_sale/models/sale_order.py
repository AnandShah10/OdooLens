from odoo import models, fields, api


class SaleOrder(models.Model):
    _inherit = "sale.order"

    x_unused_flag = fields.Boolean(default=False)


class SaleOrderMissingFieldDemo(models.Model):
    _inherit = "sale.order"

    def do_something_unsafe(self):
        # This call demonstrates a sudo() finding for the security analyzer test.
        return self.env['sale.order'].sudo().search([('id', '>', 0)])
