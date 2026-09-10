"""SBTi gates. Covers Layer 1 acceptance criterion 5 and the food-sector list."""

from __future__ import annotations

import unittest

from engines.coverage import (
    EXCLUSION_MAXIMUM,
    NEAR_TERM_COVERAGE_MINIMUM,
    RAG,
    alignment_coverage,
    assess,
    coverage_rag,
    food_sector_2030_gap,
    scope3_share,
    scope3_target_required,
)
from engines.types import Category
from tests import fixtures as fx


class MaterialityGate(unittest.TestCase):
    def test_scope_3_dominates_a_forecourt_business(self):
        share = scope3_share(fx.SCOPE_1, fx.SCOPE_2, fx.TOTAL_SCOPE_3)
        self.assertGreater(share, 0.95)
        self.assertTrue(
            scope3_target_required(fx.SCOPE_1, fx.SCOPE_2, fx.TOTAL_SCOPE_3)
        )

    def test_an_empty_footprint_does_not_divide_by_zero(self):
        self.assertEqual(scope3_share(0, 0, 0), 0.0)
        self.assertFalse(scope3_target_required(0, 0, 0))

    def test_below_forty_percent_no_scope_3_target_is_required(self):
        self.assertFalse(scope3_target_required(scope1=70, scope2=10, scope3=20))


class RagBands(unittest.TestCase):
    def test_bands_sit_either_side_of_the_sixty_seven_percent_minimum(self):
        self.assertIs(coverage_rag(0.95), RAG.GREEN)
        self.assertIs(coverage_rag(0.75), RAG.GREEN)
        self.assertIs(coverage_rag(0.74), RAG.AMBER)
        self.assertIs(coverage_rag(NEAR_TERM_COVERAGE_MINIMUM), RAG.AMBER)
        self.assertIs(coverage_rag(0.6699), RAG.RED)


class Assessment(unittest.TestCase):
    def test_the_proposed_boundary_passes_every_gate(self):
        result = assess(
            fx.FIGURES,
            scope1=fx.SCOPE_1,
            scope2=fx.SCOPE_2,
            covered_categories=fx.COVERED,
            sells_fossil_fuel=True,
        )
        self.assertTrue(result.near_term_pass)
        self.assertTrue(result.exclusion_pass)
        self.assertTrue(result.category_11_covered)
        self.assertTrue(result.submission_ready)
        self.assertEqual(result.blockers, ())

    def test_dropping_fuel_sold_fails_coverage_and_trips_c22(self):
        """Layer 1 acceptance 5: category 11 is mandatory for a fuel seller."""
        without_fuel = fx.COVERED - {Category.C11_USE_OF_SOLD}
        result = assess(
            fx.FIGURES,
            scope1=fx.SCOPE_1,
            scope2=fx.SCOPE_2,
            covered_categories=without_fuel,
            sells_fossil_fuel=True,
        )
        self.assertFalse(result.near_term_pass)
        self.assertTrue(result.category_11_mandatory)
        self.assertFalse(result.category_11_covered)
        self.assertIs(result.rag, RAG.RED)
        self.assertEqual(len(result.blockers), 2)
        self.assertTrue(any("C22" in b for b in result.blockers))

    def test_the_coverage_blocker_names_the_categories_to_add(self):
        result = assess(
            fx.FIGURES,
            scope1=fx.SCOPE_1,
            scope2=fx.SCOPE_2,
            covered_categories=frozenset({Category.C5_WASTE}),
            sells_fossil_fuel=False,
        )
        blocker = next(b for b in result.blockers if "coverage" in b)
        self.assertIn("11", blocker)
        self.assertIn("1", blocker)

    def test_category_11_is_not_mandatory_for_a_non_fuel_seller(self):
        result = assess(
            fx.FIGURES,
            scope1=fx.SCOPE_1,
            scope2=fx.SCOPE_2,
            covered_categories=fx.COVERED,
            sells_fossil_fuel=False,
        )
        self.assertFalse(result.category_11_mandatory)
        self.assertTrue(result.submission_ready)

    def test_excluding_the_food_book_breaches_the_five_percent_cap(self):
        result = assess(
            fx.FIGURES,
            scope1=fx.SCOPE_1,
            scope2=fx.SCOPE_2,
            covered_categories=fx.COVERED,
            excluded_categories=frozenset({Category.C1_PURCHASED_GOODS}),
            sells_fossil_fuel=True,
        )
        self.assertFalse(result.exclusion_pass)
        self.assertGreater(result.exclusion_share, EXCLUSION_MAXIMUM)
        self.assertTrue(any("Exclusions" in b for b in result.blockers))

    def test_long_term_bar_is_stricter_than_near_term(self):
        result = assess(
            fx.FIGURES,
            scope1=fx.SCOPE_1,
            scope2=fx.SCOPE_2,
            covered_categories=frozenset(
                {Category.C11_USE_OF_SOLD, Category.C5_WASTE}
            ),
            sells_fossil_fuel=True,
        )
        self.assertTrue(result.near_term_pass)
        self.assertFalse(result.long_term_pass)


class Alignment(unittest.TestCase):
    def test_only_counterparties_with_validated_targets_count(self):
        # Starbucks and the dairy hold validated targets; nothing else does,
        # and the unattributed fuel line cannot count towards alignment.
        share = alignment_coverage(fx.FIGURES, fx.COUNTERPARTIES)
        self.assertAlmostEqual(share, 35_000 / 844_200, places=6)

    def test_an_empty_inventory_is_not_aligned(self):
        self.assertEqual(alignment_coverage([], fx.COUNTERPARTIES), 0.0)


class FoodSectorDeadline(unittest.TestCase):
    def test_only_intensive_commodity_suppliers_without_targets_are_listed(self):
        gap = food_sector_2030_gap(fx.COUNTERPARTIES.values())
        names = [c.name for c in gap]
        self.assertEqual(names, ["Northern Beef Supply"])

    def test_a_dairy_with_a_validated_target_is_not_in_the_gap(self):
        gap_ids = {c.id for c in food_sector_2030_gap(fx.COUNTERPARTIES.values())}
        self.assertNotIn("dairy_co", gap_ids)

    def test_non_food_suppliers_are_never_listed(self):
        gap_ids = {c.id for c in food_sector_2030_gap(fx.COUNTERPARTIES.values())}
        self.assertNotIn("waste_co", gap_ids)
        self.assertNotIn("bidfood", gap_ids)


if __name__ == "__main__":
    unittest.main()
