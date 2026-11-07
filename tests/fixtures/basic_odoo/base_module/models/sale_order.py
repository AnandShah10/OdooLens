from odoo import models, fields, api


class SaleOrder(models.Model):
    _name = "sale.order"
    _description = "Sales Order"

    name = fields.Char(required=True)
    partner_id = fields.Many2one("res.partner", string="Customer")
    order_line = fields.One2many("sale.order.line", "order_id")
    amount_total = fields.Monetary(compute="_compute_amount_total", store=True)
    state = fields.Char(default="draft")

    @api.depends("order_line", "order_line.price_subtotal")
    def _compute_amount_total(self):
        for order in self:
            order.amount_total = sum(order.order_line.mapped("price_subtotal"))

    def action_confirm(self):
        for order in self:
            order.state = "sale"
        return True

    def trigger_confirm(self):
        # Exercises the "attribute-is-callee-of-a-call" exclusion: self.action_confirm() must
        # be tracked as a method call (calledMethods), never as a field usage of "action_confirm".
        return self.action_confirm()

    def get_partner_name(self):
        # Exercises TWO-HOP chained-access resolution: partner_id is a real Many2one on
        # sale.order with comodel res.partner, so `.name` after it should resolve against
        # res.partner, not sale.order — this is the "chained-access following" capability.
        return self.partner_id.name

    def get_partner_via_variable(self):
        # Exercises `chainRef` variable resolution: `partner` is assigned from `self.partner_id`
        # (not `self` itself, not an env lookup) — its type must still resolve to res.partner so
        # that `partner.name` below is correctly attributed. This is the "arbitrary variable
        # resolution beyond one hop" capability.
        partner = self.partner_id
        return partner.name

    def get_filtered_partner_name(self):
        # Exercises a type-preserving method transform: `.filtered(...)` returns the SAME model
        # (res.partner) as the recordset it was called on, so `.name` after it must still
        # resolve against res.partner, not fail to resolve.
        partner = self.partner_id
        active_partner = partner.filtered(lambda p: p.active)
        return active_partner.name

    def get_chained_method_partner_name(self):
        # Exercises a CHAIN of multiple type-preserving method calls in one expression
        # (.filtered().sorted()), not just a single one.
        active_sorted_partner = self.partner_id.filtered(lambda p: p.active).sorted()
        return active_sorted_partner.name

    def find_orders_for_partners(self, partners):
        # Intentional N+1 pattern for the ORM Doctor test fixture.
        results = []
        for partner in partners:
            orders = self.env['sale.order'].search([('partner_id', '=', partner.id)])
            results.append(orders)
        return results

    def nested_loop_writes(self, groups):
        # Intentional nested-loop N+1 pattern (2 loops deep) for the ORM Doctor test fixture.
        for group in groups:
            for partner in group:
                self.env['sale.order'].write({'state': 'sale'})

    def repeated_env_lookup(self):
        # Intentional repeated self.env[...] access (3x) for the ORM Doctor test fixture.
        a = self.env['sale.order'].browse(1)
        b = self.env['sale.order'].browse(2)
        c = self.env['sale.order'].browse(3)
        return a, b, c

    def count_all(self):
        return self.env['sale.order'].search_count([])

    @api.private
    def internal_helper_without_underscore(self):
        # Exercises the @api.private (Odoo 18.2+) opt-out: no leading underscore, but explicitly
        # excluded from RPC exposure, so impact analysis must report it as NOT RPC-reachable.
        return True
