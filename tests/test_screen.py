"""The fifteen-category screen. All fifteen, every time, each with a reason."""

from __future__ import annotations

import unittest

from engines.screen import OrgProfile, screen
from engines.types import Category


class Completeness(unittest.TestCase):
    def test_all_fifteen_categories_are_screened_in_order(self):
        rows = screen(OrgProfile(employee_count=100))
        self.assertEqual([int(r.category.value) for r in rows], list(range(1, 16)))

    def test_every_row_carries_a_reason_even_when_irrelevant(self):
        for r in screen(OrgProfile(employee_count=0, has_business_travel=False, generates_waste=False)):
            with self.subTest(category=r.category):
                self.assertTrue(r.reason)


class Rules(unittest.TestCase):
    def _row(self, profile: OrgProfile, category: Category):
        return next(r for r in screen(profile) if r.category is category)

    def test_a_fuel_seller_has_a_mandatory_category_11_target(self):
        row = self._row(OrgProfile(6_000, sells_fossil_fuel=True), Category.C11_USE_OF_SOLD)
        self.assertTrue(row.relevant)
        self.assertTrue(row.mandatory_target)
        self.assertIn("C22", row.reason)

    def test_a_non_fuel_seller_has_no_mandatory_target(self):
        row = self._row(OrgProfile(6_000), Category.C11_USE_OF_SOLD)
        self.assertFalse(row.mandatory_target)

    def test_operating_under_a_brand_is_not_category_14(self):
        row = self._row(OrgProfile(6_000, is_franchisor=False), Category.C14_FRANCHISES)
        self.assertFalse(row.relevant)
        self.assertIn("own Scope 1 and 2", row.reason)

    def test_a_franchisor_has_category_14(self):
        self.assertTrue(self._row(OrgProfile(6_000, is_franchisor=True), Category.C14_FRANCHISES).relevant)

    def test_leasing_out_switches_on_category_13(self):
        self.assertTrue(self._row(OrgProfile(6_000, leases_out=True), Category.C13_DOWNSTREAM_LEASED).relevant)
        self.assertFalse(self._row(OrgProfile(6_000), Category.C13_DOWNSTREAM_LEASED).relevant)

    def test_categories_1_3_and_4_are_always_in(self):
        rows = screen(OrgProfile(1))
        for cat in (Category.C1_PURCHASED_GOODS, Category.C3_FUEL_ENERGY, Category.C4_UPSTREAM_TRANSPORT):
            self.assertTrue(next(r for r in rows if r.category is cat).relevant)


if __name__ == "__main__":
    unittest.main()
