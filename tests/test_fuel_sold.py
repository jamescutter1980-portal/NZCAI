"""Category 11 for a fuel retailer. Layer 1 acceptance criterion 3."""

from __future__ import annotations

import unittest

from engines.factors import DESNZ_2025, ILLUSTRATIVE, FactorLibrary
from engines.fuel_sold import ElectricitySale, FuelSale, calculate, calculate_many, electricity_sold
from engines.types import Category, Tier

LIB = FactorLibrary.load(DESNZ_2025, ILLUSTRATIVE, allow_illustrative=True)


class Combustion(unittest.TestCase):
    def test_a_million_litres_of_petrol(self):
        figures = calculate(FuelSale("petrol", 1_000_000), LIB)
        self.assertEqual(len(figures), 1)
        f = figures[0]
        self.assertIs(f.category, Category.C11_USE_OF_SOLD)
        self.assertAlmostEqual(f.tco2e, 2069.16, places=2)
        self.assertIs(f.tier, Tier.C)
        self.assertIs(f.achievable_tier, Tier.C)

    def test_the_label_cites_criterion_c22(self):
        f = calculate(FuelSale("diesel", 1_000), LIB)[0]
        self.assertIn("C22", f.method_label)


class WellToTank(unittest.TestCase):
    def test_buying_for_resale_adds_a_category_1_line(self):
        figures = calculate(
            FuelSale("petrol", 1_000_000, wtt_factor_key="petrol_wtt", buys_for_resale=True), LIB
        )
        self.assertEqual([f.category for f in figures], [Category.C11_USE_OF_SOLD, Category.C1_PURCHASED_GOODS])
        self.assertAlmostEqual(figures[1].tco2e, 600.0)
        self.assertIs(figures[1].achievable_tier, Tier.B)

    def test_a_licensed_forecourt_produces_no_upstream_line(self):
        figures = calculate(FuelSale("petrol", 1_000_000, wtt_factor_key="petrol_wtt"), LIB)
        self.assertEqual(len(figures), 1)

    def test_resale_without_a_wtt_factor_is_refused(self):
        with self.assertRaises(ValueError):
            calculate(FuelSale("petrol", 1_000, buys_for_resale=True), LIB)

    def test_a_batch_flattens_both_lines_per_sale(self):
        sales = [
            FuelSale("petrol", 10, wtt_factor_key="petrol_wtt", buys_for_resale=True),
            FuelSale("diesel", 10),
        ]
        self.assertEqual(len(calculate_many(sales, LIB)), 3)


class ResoldElectricity(unittest.TestCase):
    def test_no_figure_is_raised_because_it_is_already_in_scope_2(self):
        figure, note = electricity_sold(ElectricitySale(50_000))
        self.assertIsNone(figure)
        self.assertIn("double counting", note)
        self.assertIn("50,000 kWh", note)

    def test_a_pass_through_election_is_disclosed_as_such(self):
        figure, note = electricity_sold(ElectricitySale(50_000, pass_through_elected=True))
        self.assertIsNone(figure)
        self.assertIn("pass-through election", note)


if __name__ == "__main__":
    unittest.main()
