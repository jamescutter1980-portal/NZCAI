"""Activity times factor. The arithmetic the inventory rests on."""

from __future__ import annotations

import unittest

from engines.activity import ActivityLine, calculate, calculate_many
from engines.factors import DESNZ_2025, ILLUSTRATIVE, FactorLibrary, UnitMismatch
from engines.types import Category, Tier

LIB = FactorLibrary.load(DESNZ_2025, ILLUSTRATIVE, allow_illustrative=True)


class Arithmetic(unittest.TestCase):
    def test_long_haul_flying_uses_the_published_factor(self):
        f = calculate(ActivityLine("flight_long_haul_economy", 10_000, "passenger.km"), LIB)
        self.assertAlmostEqual(f.tco2e, 10_000 * 0.11704 / 1000)
        self.assertIs(f.category, Category.C6_BUSINESS_TRAVEL)
        self.assertIs(f.tier, Tier.C)

    def test_the_category_comes_from_the_factor_row_by_default(self):
        f = calculate(ActivityLine("electricity_uk_td", 50_000, "kWh"), LIB)
        self.assertIs(f.category, Category.C3_FUEL_ENERGY)

    def test_a_caller_may_place_a_figure_and_the_label_says_so(self):
        f = calculate(
            ActivityLine("natural_gas", 1_000, "kWh", category=Category.C13_DOWNSTREAM_LEASED),
            LIB,
        )
        self.assertIs(f.category, Category.C13_DOWNSTREAM_LEASED)
        self.assertIn("placed in category 13", f.method_label)

    def test_a_scope_1_factor_with_no_placement_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            calculate(ActivityLine("natural_gas", 1_000, "kWh"), LIB)
        self.assertIn("not a Scope 3 category", str(caught.exception))


class Lineage(unittest.TestCase):
    def test_every_figure_can_be_walked_back_to_its_inputs(self):
        f = calculate(ActivityLine("rail_national", 1_200, "passenger.km", counterparty_id="x"), LIB)
        self.assertTrue(f.has_lineage)
        self.assertEqual(f.factor_key, "rail_national")
        self.assertAlmostEqual(f.factor_kgco2e, 0.03546)
        self.assertEqual(f.activity_quantity, 1_200)
        self.assertEqual(f.activity_unit, "passenger.km")
        self.assertEqual(f.factor_source, "DESNZ 2025")
        self.assertEqual(f.factor_version, "2025")

    def test_the_method_label_reads_as_a_sentence(self):
        f = calculate(ActivityLine("car_average_km", 500, "km", note="grey fleet"), LIB)
        self.assertIn("500 km", f.method_label)
        self.assertIn("grey fleet", f.method_label)


class Guards(unittest.TestCase):
    def test_a_negative_quantity_is_rejected_at_construction(self):
        with self.assertRaises(ValueError):
            ActivityLine("natural_gas", -1, "kWh")

    def test_a_unit_mismatch_propagates_rather_than_being_guessed(self):
        with self.assertRaises(UnitMismatch):
            calculate(ActivityLine("petrol", 10, "kg"), LIB)

    def test_a_batch_fails_on_the_first_bad_line(self):
        lines = [
            ActivityLine("rail_national", 10, "passenger.km"),
            ActivityLine("rail_national", 10, "kg"),
            ActivityLine("rail_national", 10, "passenger.km"),
        ]
        with self.assertRaises(UnitMismatch):
            calculate_many(lines, LIB)

    def test_a_batch_of_good_lines_returns_one_figure_each(self):
        lines = [
            ActivityLine("rail_national", 100, "passenger.km"),
            ActivityLine("car_average_km", 50, "km"),
        ]
        self.assertEqual(len(calculate_many(lines, LIB)), 2)

    def test_a_scope_1_fuel_needs_a_placement_to_enter_scope_3(self):
        """Fuel combusted by a contractor on our behalf is category 3 or 4, not ours."""
        placed = ActivityLine("diesel", 100, "litre", category=Category.C4_UPSTREAM_TRANSPORT)
        f = calculate(placed, LIB)
        self.assertIs(f.category, Category.C4_UPSTREAM_TRANSPORT)
        self.assertAlmostEqual(f.tco2e, 100 * 2.57082 / 1000)


if __name__ == "__main__":
    unittest.main()
