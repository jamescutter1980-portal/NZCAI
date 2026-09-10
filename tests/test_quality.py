"""Data quality tiers, the ESRS split and the improvement trajectory."""

from __future__ import annotations

import unittest

from engines.quality import (
    category_breakdown,
    primary_share,
    trajectory,
    uplift_tonnes,
    weighted_dq_score,
)
from engines.types import PRIMARY_TIERS, Category, Figure, Tier, is_primary
from tests import fixtures as fx


def _fig(tco2e: float, tier: Tier, achievable: Tier | None = None) -> Figure:
    return Figure(
        category=Category.C1_PURCHASED_GOODS,
        tco2e=tco2e,
        tier=tier,
        factor_source="test",
        factor_version="1",
        achievable_tier=achievable,
    )


class FigureIntegrity(unittest.TestCase):
    def test_a_figure_must_carry_a_factor_source_and_version(self):
        with self.assertRaises(ValueError):
            Figure(
                category=Category.C1_PURCHASED_GOODS,
                tco2e=1.0,
                tier=Tier.D,
                factor_source="",
                factor_version="1",
            )

    def test_negative_emissions_are_rejected(self):
        with self.assertRaises(ValueError):
            _fig(-1.0, Tier.D)


class PrimaryBoundary(unittest.TestCase):
    """Where primary data stops and secondary begins, for ESRS E1-6."""

    def test_supplier_specific_and_hybrid_are_primary(self):
        self.assertTrue(is_primary(Tier.A))
        self.assertTrue(is_primary(Tier.B))

    def test_average_spend_and_estimated_are_secondary(self):
        for tier in (Tier.C, Tier.D, Tier.E):
            with self.subTest(tier=tier):
                self.assertFalse(is_primary(tier))

    def test_every_tier_falls_on_one_side_or_the_other(self):
        self.assertEqual(
            {t for t in Tier if is_primary(t)} | {t for t in Tier if not is_primary(t)},
            set(Tier),
        )
        self.assertEqual(PRIMARY_TIERS, frozenset({Tier.A, Tier.B}))


class PrimaryShare(unittest.TestCase):
    def test_empty_inventory_has_no_primary_data(self):
        self.assertEqual(primary_share([]), 0.0)

    def test_tiers_a_and_b_count_as_primary(self):
        figures = [_fig(50, Tier.A), _fig(30, Tier.B), _fig(20, Tier.D)]
        self.assertAlmostEqual(primary_share(figures), 0.80)

    def test_fixture_inventory_is_mostly_secondary(self):
        # Only the Starbucks coffee line is supplier-reported today.
        self.assertAlmostEqual(primary_share(fx.FIGURES), 14_000 / 844_200, places=6)


class WeightedScore(unittest.TestCase):
    def test_weighting_is_by_tonnes_not_by_row_count(self):
        # Nine well-evidenced small lines must not flatter one large guess.
        figures = [_fig(1, Tier.A) for _ in range(9)] + [_fig(991, Tier.E)]
        score = weighted_dq_score(figures)
        self.assertGreater(score, 4.9)

    def test_empty_inventory_scores_zero(self):
        self.assertEqual(weighted_dq_score([]), 0.0)


class Breakdown(unittest.TestCase):
    def test_rows_are_ordered_by_category_number_not_alphabetically(self):
        rows = category_breakdown(fx.FIGURES)
        numbers = [int(r.category.value) for r in rows]
        self.assertEqual(numbers, sorted(numbers))
        self.assertEqual(numbers[:3], [1, 2, 3])

    def test_category_1_aggregates_every_supplier_line(self):
        rows = {r.category: r for r in category_breakdown(fx.FIGURES)}
        cat1 = rows[Category.C1_PURCHASED_GOODS]
        self.assertAlmostEqual(cat1.total_tco2e, 180_000)
        self.assertAlmostEqual(cat1.primary_tco2e, 14_000)
        self.assertAlmostEqual(cat1.secondary_tco2e, 166_000)

    def test_tier_breakdown_sums_to_the_category_total(self):
        for row in category_breakdown(fx.FIGURES):
            with self.subTest(category=row.category):
                self.assertAlmostEqual(
                    sum(row.tier_breakdown.values()), row.total_tco2e
                )


class Uplift(unittest.TestCase):
    def test_a_figure_already_at_its_ceiling_yields_nothing(self):
        self.assertEqual(uplift_tonnes(_fig(1000, Tier.C, Tier.C)), 0.0)

    def test_no_achievable_tier_means_no_uplift(self):
        self.assertEqual(uplift_tonnes(_fig(1000, Tier.D)), 0.0)

    def test_spend_based_to_supplier_specific_yields_three_quarters(self):
        # Tier D scores 4, tier A scores 1, against a widest possible gap of 4.
        self.assertAlmostEqual(uplift_tonnes(_fig(1000, Tier.D, Tier.A)), 750.0)

    def test_fuel_sold_offers_no_uplift_because_it_is_already_activity_data(self):
        fuel = next(
            f for f in fx.FIGURES if f.category is Category.C11_USE_OF_SOLD
        )
        self.assertEqual(uplift_tonnes(fuel), 0.0)


class TrajectoryMaths(unittest.TestCase):
    def test_plan_moves_the_inventory_from_two_percent_primary_to_twenty(self):
        t = trajectory(fx.FIGURES)
        self.assertAlmostEqual(t.current_primary_share, 14_000 / 844_200, places=6)
        self.assertAlmostEqual(t.achievable_primary_share, 176_700 / 844_200, places=6)
        self.assertGreater(t.share_gain, 0.19)

    def test_total_uplift_matches_the_sum_of_the_parts(self):
        t = trajectory(fx.FIGURES)
        self.assertAlmostEqual(t.uplift_tco2e, 119_950.0)

    def test_achievable_score_is_better_than_current(self):
        t = trajectory(fx.FIGURES)
        self.assertLess(t.achievable_dq_score, t.current_dq_score)

    def test_empty_inventory_gives_a_flat_trajectory(self):
        t = trajectory([])
        self.assertEqual(t.uplift_tco2e, 0.0)
        self.assertEqual(t.share_gain, 0.0)


if __name__ == "__main__":
    unittest.main()
