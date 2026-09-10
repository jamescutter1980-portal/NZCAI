"""Entity roll-up for a parent's statement."""

from __future__ import annotations

import unittest
from dataclasses import replace

from engines.consolidate import Entity, consolidate
from engines.types import Category
from tests import fixtures as fx

UK = Entity("uk", "Welcome Break UK", frozenset({"uk", "msa"}))
IE = Entity("ie", "Applegreen Ireland", frozenset({"ie"}), consolidation_share=0.5)
ENTITIES = {"uk": UK, "ie": IE}


def _tagged(entity_id: str):
    return [replace(f, entity_id=entity_id) for f in fx.FIGURES]


class RollUp(unittest.TestCase):
    def test_a_single_entity_sums_to_its_own_total(self):
        c = consolidate(_tagged("uk"), ENTITIES)
        self.assertAlmostEqual(c.total_tco2e, fx.TOTAL_SCOPE_3)
        self.assertEqual(c.entities, 1)
        self.assertEqual(c.figures, len(fx.FIGURES))

    def test_a_partly_owned_entity_is_scaled_by_its_share(self):
        c = consolidate(_tagged("ie"), ENTITIES)
        self.assertAlmostEqual(c.total_tco2e, fx.TOTAL_SCOPE_3 * 0.5)

    def test_categories_are_ordered_numerically(self):
        c = consolidate(_tagged("uk"), ENTITIES)
        numbers = [int(k.value) for k in c.by_category]
        self.assertEqual(numbers, sorted(numbers))

    def test_a_category_can_be_decomposed_by_entity(self):
        c = consolidate(_tagged("uk") + _tagged("ie"), ENTITIES)
        row = c.category_row(Category.C11_USE_OF_SOLD)
        self.assertAlmostEqual(row["uk"], 620_000)
        self.assertAlmostEqual(row["ie"], 310_000)

    def test_tags_slice_the_total(self):
        c = consolidate(_tagged("uk") + _tagged("ie"), ENTITIES)
        self.assertAlmostEqual(c.by_tag["msa"], fx.TOTAL_SCOPE_3)
        self.assertAlmostEqual(c.by_tag["ie"], fx.TOTAL_SCOPE_3 * 0.5)


class Guards(unittest.TestCase):
    def test_a_figure_with_no_entity_cannot_be_consolidated(self):
        with self.assertRaises(ValueError) as caught:
            consolidate(fx.FIGURES, ENTITIES)
        self.assertIn("no entity_id", str(caught.exception))

    def test_an_unknown_entity_is_refused(self):
        with self.assertRaises(ValueError):
            consolidate(_tagged("mars"), ENTITIES)

    def test_a_share_outside_the_interval_is_rejected(self):
        with self.assertRaises(ValueError):
            Entity("x", "X", consolidation_share=0.0)


if __name__ == "__main__":
    unittest.main()
