"""Spend-based emissions, with deflation and VAT stripping made explicit."""

from __future__ import annotations

import unittest

from engines.eeio import VAT_RATE, PriceIndex, SpendLine, calculate
from engines.factors import DESNZ_2025, ILLUSTRATIVE, FactorLibrary
from engines.types import Category, Tier

LIB = FactorLibrary.load(DESNZ_2025, ILLUSTRATIVE, allow_illustrative=True)
CPI = PriceIndex("test index", {2023: 95.0, 2024: 100.0, 2025: 104.0, 2026: 108.0})


class Arithmetic(unittest.TestCase):
    def test_spend_in_the_factor_year_needs_no_deflation(self):
        f = calculate(SpendLine("sector_food_beverage", 1_000, 2024), LIB)
        self.assertAlmostEqual(f.tco2e, 1_000 * 0.5 / 1000)
        self.assertIs(f.tier, Tier.D)
        self.assertIs(f.category, Category.C1_PURCHASED_GOODS)

    def test_later_spend_is_deflated_to_the_factor_price_year(self):
        f = calculate(SpendLine("sector_food_beverage", 1_080, 2026), LIB, price_index=CPI)
        self.assertAlmostEqual(f.activity_quantity, 1_000)
        self.assertIn("deflated 2026 to 2024", f.method_label)

    def test_vat_is_stripped_before_the_factor_applies(self):
        gross = 1_000 * (1 + VAT_RATE)
        f = calculate(SpendLine("sector_food_beverage", gross, 2024, vat_included=True), LIB)
        self.assertAlmostEqual(f.activity_quantity, 1_000)
        self.assertIn("VAT", f.method_label)

    def test_the_default_achievable_tier_is_supplier_specific(self):
        f = calculate(SpendLine("sector_packaging", 500, 2024), LIB)
        self.assertIs(f.achievable_tier, Tier.A)


class Guards(unittest.TestCase):
    def test_a_year_mismatch_without_an_index_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            calculate(SpendLine("sector_food_beverage", 100, 2026), LIB)
        self.assertIn("no price index", str(caught.exception))

    def test_a_year_the_index_lacks_is_refused(self):
        with self.assertRaises(ValueError):
            calculate(SpendLine("sector_food_beverage", 100, 2019), LIB, price_index=CPI)

    def test_a_physical_factor_cannot_be_used_as_a_spend_factor(self):
        with self.assertRaises(ValueError) as caught:
            calculate(SpendLine("natural_gas", 100, 2025), LIB)
        self.assertIn("not per gbp", str(caught.exception))

    def test_negative_spend_is_rejected(self):
        with self.assertRaises(ValueError):
            SpendLine("sector_food_beverage", -1, 2024)


if __name__ == "__main__":
    unittest.main()
