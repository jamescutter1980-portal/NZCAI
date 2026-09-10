"""Ledger names to legal entities, conclusively or not at all."""

from __future__ import annotations

import unittest

from engines.resolve import Candidate, group_root, normalise, resolve, resolve_many

CANDIDATES = [
    Candidate("bidfood", "Bidfood Ltd", company_number="00832890", parent_id="bidcorp"),
    Candidate("bidcorp", "Bidcorp UK Holdings Limited"),
    Candidate("kfc", "KFC UK & Ireland Ltd", parent_id="yum"),
    Candidate("tacobell", "Taco Bell UK Ltd", parent_id="yum"),
    Candidate("yum", "Yum! Brands Inc"),
    Candidate("bp_a", "BP Retail Ltd"),
    Candidate("bp_b", "BP Retail Services Ltd"),
]
BY_ID = {c.id: c for c in CANDIDATES}


class Normalisation(unittest.TestCase):
    def test_legal_suffixes_and_filler_are_stripped(self):
        self.assertEqual(normalise("The Bidfood Group (UK) Ltd."), "bidfood")

    def test_ampersand_becomes_and_then_is_dropped(self):
        self.assertEqual(normalise("KFC UK & Ireland Ltd"), "kfc ireland")

    def test_case_and_punctuation_do_not_matter(self):
        self.assertEqual(normalise("YUM! BRANDS, INC."), normalise("Yum Brands Inc"))


class Matching(unittest.TestCase):
    def test_a_company_number_is_conclusive_whatever_the_name(self):
        r = resolve("Some Misspelt Name", CANDIDATES, company_number="832890")
        self.assertEqual(r.candidate.id, "bidfood")
        self.assertEqual(r.confidence, 1.0)
        self.assertTrue(r.resolved)

    def test_a_normalised_exact_name_is_strong(self):
        r = resolve("BIDFOOD LIMITED", CANDIDATES)
        self.assertEqual(r.candidate.id, "bidfood")
        self.assertEqual(r.method, "normalised_name")
        self.assertTrue(r.resolved)

    def test_a_trading_style_with_the_legal_form_stripped_is_an_exact_match(self):
        # "Taco Bell" and "Taco Bell UK Ltd" normalise to the same thing.
        r = resolve("Taco Bell", CANDIDATES)
        self.assertEqual(r.candidate.id, "tacobell")
        self.assertEqual(r.method, "normalised_name")

    def test_a_partial_match_is_a_proposal_for_review(self):
        r = resolve("Taco Bell Restaurants", CANDIDATES)
        self.assertEqual(r.candidate.id, "tacobell")
        self.assertEqual(r.method, "partial_name")
        self.assertTrue(r.needs_review)
        self.assertFalse(r.resolved)

    def test_a_short_name_is_never_partially_matched(self):
        # "bp" would otherwise match both BP entities.
        r = resolve("BP", CANDIDATES)
        self.assertIsNone(r.candidate)

    def test_ambiguity_is_reported_not_guessed(self):
        # Contains both "bp retail" and "bp retail services".
        r = resolve("BP Retail Services Northern", CANDIDATES)
        self.assertIsNone(r.candidate)
        self.assertIn("ambiguous", r.method)

    def test_no_match_is_honest(self):
        r = resolve("Acme Widgets", CANDIDATES)
        self.assertIsNone(r.candidate)
        self.assertEqual(r.method, "no match")

    def test_a_batch_keeps_order(self):
        out = resolve_many([("Bidfood Ltd", None), ("Nobody", None)], CANDIDATES)
        self.assertEqual([r.raw_name for r in out], ["Bidfood Ltd", "Nobody"])


class Groups(unittest.TestCase):
    def test_a_franchised_brand_resolves_to_its_group_parent(self):
        self.assertEqual(group_root(BY_ID["kfc"], BY_ID).id, "yum")
        self.assertEqual(group_root(BY_ID["tacobell"], BY_ID).id, "yum")

    def test_a_root_is_its_own_root(self):
        self.assertEqual(group_root(BY_ID["yum"], BY_ID).id, "yum")

    def test_a_dangling_parent_stops_at_the_last_known_entity(self):
        orphan = Candidate("o", "Orphan Ltd", parent_id="missing")
        self.assertEqual(group_root(orphan, BY_ID).id, "o")

    def test_a_cycle_is_a_data_error(self):
        a = Candidate("a", "A", parent_id="b")
        b = Candidate("b", "B", parent_id="a")
        with self.assertRaises(ValueError):
            group_root(a, {"a": a, "b": b})


if __name__ == "__main__":
    unittest.main()
