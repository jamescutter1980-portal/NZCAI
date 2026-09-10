"""Conflict detection. Covers Layer 2 acceptance criterion 5."""

from __future__ import annotations

import unittest

from engines.conflict import (
    ConflictClass,
    allocation_basis_changed,
    certificate_scope_gap,
    collect,
    overallocation,
    reported_vs_published,
    restatement_without_note,
    unevidenced_renewable_claim,
    unit_mismatch,
)


class ReportedAgainstPublished(unittest.TestCase):
    def test_rounding_differences_are_not_worth_a_persons_time(self):
        self.assertIsNone(
            reported_vs_published(
                "Scope 1",
                12_000,
                12_100,
                reported_source="questionnaire",
                published_source="annual report",
            )
        )

    def test_a_material_difference_is_raised_with_a_proposed_resolution(self):
        conflict = reported_vs_published(
            "Scope 1",
            9_500,
            12_000,
            reported_source="questionnaire",
            published_source="2025 annual report",
        )
        self.assertIsNotNone(conflict)
        self.assertIs(conflict.conflict_class, ConflictClass.REPORTED_VS_PUBLISHED)
        self.assertEqual(conflict.proposed_resolution, "Use the published figure")
        self.assertIn("assured", conflict.rationale)

    def test_both_values_and_both_sources_are_kept(self):
        conflict = reported_vs_published(
            "Scope 1",
            9_500,
            12_000,
            reported_source="questionnaire",
            published_source="2025 annual report",
        )
        self.assertIn("9,500", conflict.value_a)
        self.assertIn("12,000", conflict.value_b)
        self.assertEqual(conflict.source_a, "questionnaire")
        self.assertEqual(conflict.source_b, "2025 annual report")


class Overallocation(unittest.TestCase):
    def test_allocating_more_than_the_counterparty_reports_is_impossible(self):
        conflict = overallocation("Bidfood", 130_000, 100_000)
        self.assertIsNotNone(conflict)
        self.assertIs(conflict.conflict_class, ConflictClass.OVERALLOCATION)
        self.assertIn("single stated basis", conflict.proposed_resolution)

    def test_allocation_within_tolerance_passes(self):
        self.assertIsNone(overallocation("Bidfood", 102_000, 100_000))

    def test_an_unknown_counterparty_total_cannot_be_tested(self):
        self.assertIsNone(overallocation("Bidfood", 130_000, 0))


class AllocationBasis(unittest.TestCase):
    def test_an_unexplained_change_breaks_comparability(self):
        conflict = allocation_basis_changed("Bidfood", "revenue_share", "volume_share")
        self.assertIsNotNone(conflict)
        self.assertIn("restate", conflict.proposed_resolution)

    def test_an_explained_change_is_fine(self):
        self.assertIsNone(
            allocation_basis_changed(
                "Bidfood",
                "revenue_share",
                "volume_share",
                explanation="Moved to volume after the 2026 contract change.",
            )
        )

    def test_an_unchanged_basis_raises_nothing(self):
        self.assertIsNone(
            allocation_basis_changed("Bidfood", "volume_share", "volume_share")
        )


class Units(unittest.TestCase):
    def test_a_footprint_per_litre_cannot_be_applied_to_kilograms(self):
        conflict = unit_mismatch("Rapeseed oil", "litre", "kg")
        self.assertIsNotNone(conflict)
        self.assertIs(conflict.conflict_class, ConflictClass.UNIT_MISMATCH)
        self.assertIn("conversion", conflict.proposed_resolution)

    def test_matching_units_raise_nothing(self):
        self.assertIsNone(unit_mismatch("Rapeseed oil", "kg", "kg"))


class RenewableClaims(unittest.TestCase):
    def test_a_zero_carbon_claim_needs_an_instrument_behind_it(self):
        conflict = unevidenced_renewable_claim("Vale Dairies", True, False)
        self.assertIsNotNone(conflict)
        self.assertIn("location-based", conflict.proposed_resolution)

    def test_a_certificated_claim_stands(self):
        self.assertIsNone(unevidenced_renewable_claim("Vale Dairies", True, True))

    def test_no_claim_means_nothing_to_check(self):
        self.assertIsNone(unevidenced_renewable_claim("Vale Dairies", False, False))


class CertificateScope(unittest.TestCase):
    def test_a_valid_certificate_for_the_wrong_factory_is_caught(self):
        conflict = certificate_scope_gap(
            "Northern Beef Supply", ["Carlisle"], ["Carlisle", "Preston"]
        )
        self.assertIsNotNone(conflict)
        self.assertIn("Preston", conflict.value_b)
        self.assertIn("uncertified", conflict.proposed_resolution)

    def test_full_coverage_raises_nothing(self):
        self.assertIsNone(
            certificate_scope_gap(
                "Northern Beef Supply", ["Carlisle", "Preston"], ["Carlisle"]
            )
        )


class Restatements(unittest.TestCase):
    def test_a_moved_prior_year_figure_needs_a_note(self):
        conflict = restatement_without_note(
            "Category 1 2025", 100_000, 130_000, has_note=False
        )
        self.assertIsNotNone(conflict)
        self.assertIn("assurance", conflict.rationale)

    def test_a_noted_restatement_is_fine(self):
        self.assertIsNone(
            restatement_without_note(
                "Category 1 2025", 100_000, 130_000, has_note=True
            )
        )


class Collection(unittest.TestCase):
    def test_detectors_that_found_nothing_are_dropped(self):
        conflicts = collect(
            reported_vs_published(
                "Scope 1", 100, 100, reported_source="a", published_source="b"
            ),
            unit_mismatch("Oil", "litre", "kg"),
            unevidenced_renewable_claim("X", False, False),
        )
        self.assertEqual(len(conflicts), 1)
        self.assertIs(conflicts[0].conflict_class, ConflictClass.UNIT_MISMATCH)

    def test_an_all_clear_returns_nothing(self):
        self.assertEqual(collect(None, None), [])


if __name__ == "__main__":
    unittest.main()
