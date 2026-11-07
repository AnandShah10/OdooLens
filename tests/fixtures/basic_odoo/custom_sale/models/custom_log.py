from odoo import models, fields


class CustomSaleLog(models.Model):
    _name = "custom_sale.log"
    _description = "Custom Sale Log (deliberately has no access rule, for the ACL analyzer test)"

    message = fields.Char()
