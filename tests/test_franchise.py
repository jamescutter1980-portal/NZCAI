"""Per-outlet packs for reporting upward. Layer 1 acceptance criterion 8."""

from __future__ import annotations

import unittest

from engines.factors import FactorLibrary
from engines.franchise import brand_pack, outlet_pack
from engines.leased import OutletEnergy
from engines.types import OperatorRole as R

LIB = FactorLibrary.load()
KFC_1 = OutletEnergy("kfc_1", "uk", R.FRANCHISEE, 40_000, 90_000, 2025, allocation_share=0.6, allocation_method="floor area")
KFC_2 = OutletEnergy("kfc_2", "uk", R.FRANCHISEE, 20_000, 60_000, 2025)


class OutletPack(unittest.TestCase):
    def test_energy_and_emissions_reflect_the_allocation(self):
        pack = outlet_pack(KFC_1, LIB, brand="KFC", floor_area_m2=320, waste_tonnes=4.2)
        self.assertAlmostEqual(pack.total_kwh, (40_000 + 90_000) * 0.6)
        self.assertAlmostEqual(pack.scope1_tco2e, 24_000 * 0.18296 / 1000)
        self.assertAlmostEqual(pack.scope2_tco2e, 54_000 * 0.177 / 1000)
        self.assertEqual(pack.allocation_method, "floor area")

    def test_intensities_need_a_floor_area(self):
        with_area = outlet_pack(KFC_1, LIB, brand="KFC", floor_area_m2=320)
        without = outlet_pack(KFC_1, LIB, brand="KFC")
        self.assertAlmostEqual(with_area.kwh_per_m2, 78_000 / 320)
        self.assertIsNone(without.kwh_per_m2)
        self.assertIsNone(without.kgco2e_per_m2)

    def test_the_row_carries_the_factor_versions_used(self):
        row = outlet_pack(KFC_1, LIB, brand="KFC").as_row()
        self.assertIn("DESNZ 2025 2025", row["factor_versions"])
        self.assertEqual(row["brand"], "KFC")


class BrandPack(unittest.TestCase):
    def test_totals_sum_across_outlets(self):
        packs = [outlet_pack(KFC_1, LIB, brand="KFC", floor_area_m2=320), outlet_pack(KFC_2, LIB, brand="KFC", floor_area_m2=280)]
        brand = brand_pack(packs)
        self.assertEqual(brand["outlets"], 2)
        self.assertAlmostEqual(brand["total_kwh"], round(78_000 + 80_000))

    def test_intensity_is_recomputed_from_totals_not_averaged(self):
        # One outlet has no area on record; it must not distort the brand figure.
        packs = [outlet_pack(KFC_1, LIB, brand="KFC", floor_area_m2=320), outlet_pack(KFC_2, LIB, brand="KFC")]
        brand = brand_pack(packs)
        self.assertEqual(brand["outlets_with_floor_area"], 1)
        self.assertAlmostEqual(brand["kwh_per_m2"], round(78_000 / 320, 1))

    def test_mixing_brands_is_refused(self):
        packs = [outlet_pack(KFC_1, LIB, brand="KFC"), outlet_pack(KFC_2, LIB, brand="Taco Bell")]
        with self.assertRaises(ValueError):
            brand_pack(packs)

    def test_an_empty_brand_reports_zero_outlets(self):
        self.assertEqual(brand_pack([]), {"outlets": 0})


if __name__ == "__main__":
    unittest.main()
