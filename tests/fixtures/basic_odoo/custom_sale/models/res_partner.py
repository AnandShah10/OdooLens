from odoo import models, fields, api


class ResPartner(models.Model):
    _inherit = "res.partner"

    x_customer_score = fields.Float(
        compute="_compute_customer_score",
        store=True,
    )

    @api.depends("sale_order_ids", "sale_order_ids.amount_total")
    def _compute_customer_score(self):
        for partner in self:
            partner.x_customer_score = sum(partner.sale_order_ids.mapped("amount_total"))
