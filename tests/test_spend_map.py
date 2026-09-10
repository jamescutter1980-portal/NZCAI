"""Ledger lines to sectors: exclusions first, codes before keywords, never guessed."""

from __future__ import annotations

import unittest

from engines.spend_map import Exclusion, LedgerLine, MappingRule, map_line, map_many
from engines.types import Category

RULES = [
    MappingRule("sector_food_beverage", Category.C1_PURCHASED_GOODS, 0.9, gl_pattern=r"50\d\d", label="Food purchases"),
    MappingRule("sector_packaging", Category.C1_PURCHASED_GOODS, 0.7, keyword_pattern=r"packag|cups?|lids?", label="Packaging"),
    MappingRule("sector_road_freight", Category.C4_UPSTREAM_TRANSPORT, 0.8, keyword_pattern=r"haulage|freight|delivery charge", label="Freight"),
    MappingRule("sector_construction", Category.C2_CAPITAL_GOODS, 0.9, gl_pattern=r"1[0-9]{3}", label="Capital works"),
]


def _line(id: str, gl: str, desc: str) -> LedgerLine:
    return LedgerLine(id, gl, desc, "Supplier", 100.0, 2026)


class Exclusions(unittest.TestCase):
    def test_vat_carries_no_emissions(self):
        m = map_line(_line("a", "5001", "VAT on food invoice"), RULES)
        self.assertTrue(m.excluded)
        self.assertIs(m.exclusion, Exclusion.VAT)
        self.assertFalse(m.mapped)

    def test_metered_energy_is_excluded_from_the_spend_method_not_the_inventory(self):
        m = map_line(_line("b", "7000", "Electricity Q1 MPAN 1200034"), RULES)
        self.assertIs(m.exclusion, Exclusion.METERED_ENERGY)

    def test_gas_oil_is_not_caught_by_the_gas_exclusion(self):
        m = map_line(_line("c", "5010", "Gas oil for generator"), RULES)
        self.assertFalse(m.excluded)

    def test_exclusions_win_over_any_mapping_rule(self):
        m = map_line(_line("d", "5001", "Intercompany recharge for food"), RULES)
        self.assertIs(m.exclusion, Exclusion.INTERCOMPANY)


class Precedence(unittest.TestCase):
    def test_a_gl_code_beats_a_keyword_whatever_the_list_order(self):
        # Both a food GL code and a packaging keyword; the code wins.
        m = map_line(_line("e", "5020", "Cups and lids"), RULES)
        self.assertEqual(m.sector_key, "sector_food_beverage")
        self.assertEqual(m.rule_label, "Food purchases")

    def test_a_keyword_maps_when_no_code_rule_applies(self):
        m = map_line(_line("f", "6100", "Weekly haulage"), RULES)
        self.assertEqual(m.sector_key, "sector_road_freight")
        self.assertIs(m.category, Category.C4_UPSTREAM_TRANSPORT)
        self.assertAlmostEqual(m.confidence, 0.8)


class ReviewQueue(unittest.TestCase):
    def test_an_unmatched_line_is_queued_not_guessed(self):
        m = map_line(_line("g", "9999", "Miscellaneous"), RULES)
        self.assertTrue(m.needs_review)
        self.assertEqual(m.confidence, 0.0)
        self.assertIn("review", m.rule_label)

    def test_a_batch_preserves_order_and_ids(self):
        lines = [_line("1", "5001", "Beef"), _line("2", "9999", "Other")]
        out = map_many(lines, RULES)
        self.assertEqual([m.line_id for m in out], ["1", "2"])
        self.assertTrue(out[0].mapped and out[1].needs_review)


if __name__ == "__main__":
    unittest.main()
