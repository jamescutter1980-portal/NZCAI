"""The factor library: loading, lookup, unit handling and placeholder refusal."""

from __future__ import annotations

import unittest

from engines.factors import (
    DESNZ_2025,
    ILLUSTRATIVE,
    FactorLibrary,
    FactorNotFound,
    IllustrativeFactorRefused,
    UnitMismatch,
    convert_quantity,
)


class Loading(unittest.TestCase):
    def test_the_default_library_is_the_verified_desnz_set_only(self):
        lib = FactorLibrary.load()
        self.assertEqual(len(lib), 15)
        self.assertTrue(all(not f.is_illustrative for f in lib))

    def test_every_loaded_factor_carries_a_source_and_version(self):
        for f in FactorLibrary.load(DESNZ_2025, ILLUSTRATIVE, allow_illustrative=True):
            with self.subTest(key=f.key):
                self.assertTrue(f.source)
                self.assertTrue(f.version)

    def test_a_duplicate_key_is_a_loading_error(self):
        with self.assertRaises(ValueError):
            FactorLibrary.load(DESNZ_2025, DESNZ_2025)

    def test_versions_are_reported_for_the_methodology_sheet(self):
        self.assertIn("DESNZ 2025 2025", FactorLibrary.load().versions)


class Placeholders(unittest.TestCase):
    def test_placeholders_are_refused_unless_opted_in(self):
        lib = FactorLibrary.load(DESNZ_2025, ILLUSTRATIVE)
        self.assertIn("food_beef_kg", lib)
        with self.assertRaises(IllustrativeFactorRefused):
            lib.get("food_beef_kg")

    def test_placeholders_are_admitted_when_opted_in(self):
        lib = FactorLibrary.load(DESNZ_2025, ILLUSTRATIVE, allow_illustrative=True)
        self.assertTrue(lib.get("food_beef_kg").is_illustrative)

    def test_a_verified_factor_is_never_blocked_by_the_flag(self):
        lib = FactorLibrary.load(DESNZ_2025, ILLUSTRATIVE)
        self.assertFalse(lib.get("natural_gas").is_illustrative)


class Lookup(unittest.TestCase):
    def test_an_unknown_key_names_what_is_available(self):
        with self.assertRaises(FactorNotFound) as caught:
            FactorLibrary.load().get("unobtainium")
        self.assertIn("natural_gas", str(caught.exception))

    def test_uk_grid_electricity_is_the_published_2025_value(self):
        f = FactorLibrary.load().get("electricity_uk_grid")
        self.assertAlmostEqual(f.kgco2e_per_unit, 0.17700)
        self.assertEqual(f.unit, "kWh")
        self.assertEqual(f.scope, "2")

    def test_factors_can_be_listed_by_category(self):
        lib = FactorLibrary.load()
        travel = lib.for_category("Category 6")
        self.assertEqual(len(travel), 4)


class Units(unittest.TestCase):
    def test_a_tonne_of_emissions_from_a_thousand_kwh_of_grid_electricity(self):
        f = FactorLibrary.load().get("electricity_uk_grid")
        self.assertAlmostEqual(f.tco2e_for(1000, "kWh"), 0.177)

    def test_megawatt_hours_convert_exactly(self):
        f = FactorLibrary.load().get("electricity_uk_grid")
        self.assertAlmostEqual(f.tco2e_for(1, "MWh"), f.tco2e_for(1000, "kWh"))

    def test_a_unit_with_no_exact_conversion_is_refused(self):
        f = FactorLibrary.load().get("natural_gas")
        with self.assertRaises(UnitMismatch):
            f.tco2e_for(100, "m3")

    def test_conversion_is_exact_and_symmetric(self):
        self.assertAlmostEqual(convert_quantity(2.5, "tonne", "kg"), 2500)
        self.assertAlmostEqual(convert_quantity(2500, "kg", "tonne"), 2.5)
        self.assertEqual(convert_quantity(7, "litre", "litre"), 7)


if __name__ == "__main__":
    unittest.main()
