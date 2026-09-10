"""What is still needed from a counterparty. Ask last."""

from __future__ import annotations

import unittest

from engines.scope import categories_served, compute_need, compute_needs
from engines.types import Category, RelationshipRole as R, Tier
from tests import fixtures as fx


class CategoriesServed(unittest.TestCase):
    def test_a_waste_contractor_serves_only_category_5(self):
        self.assertEqual(categories_served({R.WASTE_CONTRACTOR}), frozenset({Category.C5_WASTE}))

    def test_a_franchisor_and_supplier_serves_the_union(self):
        served = categories_served(fx.STARBUCKS.roles)
        self.assertIn(Category.C1_PURCHASED_GOODS, served)

    def test_a_lender_serves_nothing(self):
        self.assertEqual(categories_served({R.LENDER}), frozenset())


class Needs(unittest.TestCase):
    def test_nothing_held_means_everything_outstanding(self):
        need = compute_need(fx.BEEF_CO, 2026, Category.C1_PURCHASED_GOODS, [])
        self.assertEqual(need.satisfied, ())
        self.assertEqual(len(need.outstanding), 5)
        self.assertFalse(need.complete)

    def test_held_fields_are_removed_from_the_ask(self):
        need = compute_need(fx.BEEF_CO, 2026, Category.C1_PURCHASED_GOODS, ["scope1_total", "scope2_total"])
        self.assertNotIn("scope1_total", need.outstanding)
        self.assertIn("product_footprints", need.outstanding)

    def test_a_complete_need_has_nothing_to_ask(self):
        fields = ["product_footprints", "scope1_total", "scope2_total", "allocation_basis", "our_share"]
        need = compute_need(fx.BEEF_CO, 2026, Category.C1_PURCHASED_GOODS, fields)
        self.assertTrue(need.complete)
        self.assertTrue(need.nothing_to_ask)

    def test_category_1_can_reach_tier_a_because_footprints_exist_as_a_field(self):
        need = compute_need(fx.BEEF_CO, 2026, Category.C1_PURCHASED_GOODS, [])
        self.assertIs(need.achievable_tier, Tier.A)

    def test_upstream_transport_tops_out_at_tier_b(self):
        need = compute_need(fx.BIDFOOD, 2026, Category.C4_UPSTREAM_TRANSPORT, [])
        self.assertIs(need.achievable_tier, Tier.B)

    def test_a_category_with_no_defined_fields_has_nothing_to_ask(self):
        need = compute_need(fx.BEEF_CO, 2026, Category.C15_INVESTMENTS, [])
        self.assertTrue(need.nothing_to_ask)
        self.assertIs(need.achievable_tier, Tier.C)


class PerCounterparty(unittest.TestCase):
    def test_needs_cover_every_category_the_roles_serve_in_order(self):
        needs = compute_needs(fx.BIDFOOD, 2026, {})
        cats = [int(n.category.value) for n in needs]
        self.assertEqual(cats, sorted(cats))
        self.assertEqual(set(cats), {1, 2, 4})

    def test_a_concession_needs_consent_for_its_meter_data(self):
        needs = compute_needs(fx.CHARGING, 2026, {})
        c13 = next(n for n in needs if n.category is Category.C13_DOWNSTREAM_LEASED)
        self.assertIn("consent", c13.outstanding)


if __name__ == "__main__":
    unittest.main()
