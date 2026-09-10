"""Supplier-reported figures: the tiers the engagement layer exists to reach."""

from __future__ import annotations

import unittest

from engines.factors import UnitMismatch
from engines.partner import AllocationBasis, PartnerResponse, ProductFootprint, allocate, apply_footprint
from engines.types import Category, Tier


def _response(**overrides) -> PartnerResponse:
    base = dict(
        counterparty_id="beef_co",
        counterparty_name="Northern Beef Supply",
        period=2025,
        scope1_tco2e=9_500,
        scope2_tco2e=2_500,
        our_share=0.15,
        basis=AllocationBasis.VOLUME_SHARE,
    )
    base.update(overrides)
    return PartnerResponse(**base)


class Hybrid(unittest.TestCase):
    def test_our_share_of_their_reported_total_is_tier_b(self):
        f = allocate(_response())
        self.assertIs(f.tier, Tier.B)
        self.assertAlmostEqual(f.tco2e, 12_000 * 0.15)
        self.assertIs(f.achievable_tier, Tier.A)

    def test_the_counterparty_is_the_factor_source(self):
        f = allocate(_response())
        self.assertIn("Northern Beef Supply", f.factor_source)
        self.assertEqual(f.factor_version, "2025")
        self.assertEqual(f.counterparty_id, "beef_co")

    def test_the_label_records_basis_and_verification(self):
        f = allocate(_response(verified=True))
        self.assertIn("volume share", f.method_label)
        self.assertIn("verified", f.method_label)
        self.assertNotIn("unverified", f.method_label)

    def test_upstream_scope_3_is_excluded_unless_asked_for(self):
        r = _response(scope3_upstream_tco2e=20_000)
        conservative = allocate(r)
        cradle = allocate(r, include_upstream=True)
        self.assertAlmostEqual(conservative.tco2e, 1_800)
        self.assertAlmostEqual(cradle.tco2e, 4_800)
        self.assertIn("upstream 3", cradle.method_label)

    def test_a_share_outside_zero_to_one_is_rejected(self):
        with self.assertRaises(ValueError):
            _response(our_share=1.5)


class SupplierSpecific(unittest.TestCase):
    def setUp(self):
        self.pcf = ProductFootprint(
            counterparty_id="starbucks",
            counterparty_name="Starbucks",
            item_key="coffee_beans",
            kgco2e_per_unit=18.0,
            unit="kg",
            version="2026",
            origin="PACT",
            verified=True,
        )

    def test_quantity_times_their_footprint_is_tier_a(self):
        f = apply_footprint(self.pcf, 2_000, "kg")
        self.assertIs(f.tier, Tier.A)
        self.assertAlmostEqual(f.tco2e, 36.0)
        self.assertIs(f.category, Category.C1_PURCHASED_GOODS)

    def test_tonnes_convert_exactly_to_the_footprint_unit(self):
        self.assertAlmostEqual(apply_footprint(self.pcf, 2, "tonne").tco2e, 36.0)

    def test_a_unit_that_will_not_reconcile_is_refused(self):
        with self.assertRaises(UnitMismatch):
            apply_footprint(self.pcf, 100, "litre")

    def test_the_origin_is_recorded_on_the_source(self):
        f = apply_footprint(self.pcf, 1, "kg")
        self.assertIn("PACT", f.factor_source)
        self.assertIn("verified", f.method_label)

    def test_lineage_is_complete(self):
        f = apply_footprint(self.pcf, 1, "kg")
        self.assertTrue(f.has_lineage)
        self.assertEqual(f.factor_key, "pcf:starbucks:coffee_beans")


if __name__ == "__main__":
    unittest.main()
