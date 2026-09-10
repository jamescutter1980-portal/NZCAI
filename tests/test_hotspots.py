"""Ranking and what-if levers that never touch the record."""

from __future__ import annotations

import unittest

from engines.hotspots import lever_effect, lever_scale, lever_substitute_factor, rank
from engines.types import Category, Tier
from tests import fixtures as fx


class Ranking(unittest.TestCase):
    def test_categories_rank_with_fuel_sold_first(self):
        spots = rank(fx.FIGURES, by="category")
        self.assertEqual(spots[0].key, "11")
        self.assertAlmostEqual(spots[0].share, 620_000 / 844_200, places=6)

    def test_counterparties_rank_with_unattributed_named_as_such(self):
        spots = rank(fx.FIGURES, by="counterparty", top=2)
        self.assertEqual([s.key for s in spots], ["(unattributed)", "bidfood"])

    def test_shares_sum_to_one(self):
        self.assertAlmostEqual(sum(s.share for s in rank(fx.FIGURES, by="counterparty")), 1.0)

    def test_an_empty_inventory_ranks_nothing(self):
        self.assertEqual(rank([]), [])


class Levers(unittest.TestCase):
    def test_scaling_fuel_sold_models_the_shift_to_charging(self):
        after = lever_scale(
            fx.FIGURES,
            where=lambda f: f.category is Category.C11_USE_OF_SOLD,
            multiplier=0.8,
            label="20% to EV",
        )
        effect = lever_effect(fx.FIGURES, after)
        self.assertAlmostEqual(effect["delta_tco2e"], -124_000)
        self.assertLess(effect["delta_share"], 0)

    def test_the_original_figures_are_untouched(self):
        before = [f.tco2e for f in fx.FIGURES]
        lever_scale(fx.FIGURES, where=lambda f: True, multiplier=0.0, label="wipe")
        self.assertEqual([f.tco2e for f in fx.FIGURES], before)

    def test_substituting_a_factor_changes_number_and_tier_only_where_lineage_exists(self):
        from engines.activity import ActivityLine, calculate
        from engines.factors import FactorLibrary

        lib = FactorLibrary.load()
        with_lineage = calculate(ActivityLine("electricity_uk_td", 100_000, "kWh"), lib)
        figures = [with_lineage, fx.FIGURES[0]]  # fixture figure has no lineage
        after = lever_substitute_factor(
            figures,
            factor_key="electricity_uk_td",
            new_kgco2e=0.010,
            new_source="Supplier",
            new_version="2026",
            new_tier=Tier.A,
        )
        self.assertAlmostEqual(after[0].tco2e, 100_000 * 0.010 / 1000)
        self.assertIs(after[0].tier, Tier.A)
        self.assertIn("what-if", after[0].method_label)
        self.assertEqual(after[1], fx.FIGURES[0])

    def test_a_negative_multiplier_is_rejected(self):
        with self.assertRaises(ValueError):
            lever_scale(fx.FIGURES, where=lambda f: True, multiplier=-1, label="x")


if __name__ == "__main__":
    unittest.main()
