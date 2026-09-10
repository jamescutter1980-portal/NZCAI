"""Outlet energy into categories 13, 8 and 14, via the boundary rules."""

from __future__ import annotations

import unittest

from engines.factors import FactorLibrary
from engines.leased import OutletEnergy, calculate, calculate_many
from engines.types import Category, OperatorRole as R, Perspective, Tier

LIB = FactorLibrary.load()


class Concession(unittest.TestCase):
    def test_a_charging_partner_on_leased_space_is_category_13(self):
        p = calculate(OutletEnergy("hub", "uk", R.EV_CHARGING_PARTNER, 0, 120_000, 2025), LIB)
        self.assertEqual(len(p.figures), 1)
        f = p.figures[0]
        self.assertIs(f.category, Category.C13_DOWNSTREAM_LEASED)
        self.assertAlmostEqual(f.tco2e, 120_000 * 0.177 / 1000)
        self.assertIs(f.achievable_tier, Tier.A)

    def test_a_partner_with_no_lease_is_outside_the_boundary(self):
        p = calculate(
            OutletEnergy("hub", "uk", R.EV_CHARGING_PARTNER, 0, 120_000, 2025, space_leased=False), LIB
        )
        self.assertEqual(p.figures, ())
        self.assertIn("no lease", p.note)

    def test_the_same_concession_is_the_occupiers_own_scope_2(self):
        p = calculate(
            OutletEnergy("shop", "uk", R.LANDLORD_CONCESSION, 0, 50_000, 2025),
            LIB,
            perspective=Perspective.OCCUPIER,
        )
        self.assertEqual(p.figures, ())
        self.assertIn("scope_2", p.note)


class Operated(unittest.TestCase):
    def test_our_own_outlet_produces_no_scope_3_figure(self):
        p = calculate(OutletEnergy("kfc", "uk", R.FRANCHISEE, 40_000, 90_000, 2025), LIB)
        self.assertEqual(p.figures, ())
        self.assertIn("operational inventory", p.note)

    def test_landlord_recharged_energy_is_our_category_8(self):
        p = calculate(
            OutletEnergy("hotel", "uk", R.HOTEL_FRANCHISEE, 30_000, 60_000, 2025, energy_bought_by_landlord=True),
            LIB,
        )
        self.assertEqual([f.category for f in p.figures], [Category.C8_UPSTREAM_LEASED] * 2)
        self.assertAlmostEqual(sum(f.tco2e for f in p.figures), 30_000 * 0.18296 / 1000 + 60_000 * 0.177 / 1000)


class Franchisor(unittest.TestCase):
    def test_a_franchised_outlet_is_the_franchisors_category_14(self):
        p = calculate(OutletEnergy("kfc", "uk", R.FRANCHISOR, 40_000, 90_000, 2025), LIB)
        self.assertEqual([f.category for f in p.figures], [Category.C14_FRANCHISES] * 2)


class Allocation(unittest.TestCase):
    def test_shared_energy_is_scaled_by_the_allocation_share(self):
        p = calculate(
            OutletEnergy("hub", "uk", R.EV_CHARGING_PARTNER, 0, 100_000, 2025, allocation_share=0.25, allocation_method="floor area"),
            LIB,
        )
        f = p.figures[0]
        self.assertAlmostEqual(f.activity_quantity, 25_000)
        self.assertIn("25%", f.method_label)
        self.assertIn("floor area", f.method_label)

    def test_zero_energy_yields_no_figure_rather_than_a_zero(self):
        p = calculate(OutletEnergy("hub", "uk", R.EV_CHARGING_PARTNER, 0, 0, 2025), LIB)
        self.assertEqual(p.figures, ())

    def test_a_share_outside_zero_to_one_is_rejected(self):
        with self.assertRaises(ValueError):
            OutletEnergy("x", "uk", R.FRANCHISEE, 1, 1, 2025, allocation_share=1.2)


class Batch(unittest.TestCase):
    def test_one_placed_result_per_outlet(self):
        outlets = [
            OutletEnergy("a", "uk", R.EV_CHARGING_PARTNER, 0, 1_000, 2025),
            OutletEnergy("b", "uk", R.FRANCHISEE, 1_000, 1_000, 2025),
        ]
        results = calculate_many(outlets, LIB)
        self.assertEqual([r.outlet_id for r in results], ["a", "b"])


if __name__ == "__main__":
    unittest.main()
