from odoo import models, fields, api


class SaleOrder(models.Model):
    _inherit = "sale.order"

    priority = fields.Char(default="0")

    def action_confirm(self):
        # Override: extend base behavior.
        res = super().action_confirm()
        return res
