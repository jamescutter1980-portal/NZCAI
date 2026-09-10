"""Engagement scoring. Covers Layer 2 acceptance criterion 9."""

from __future__ import annotations

import unittest
from datetime import date

from engines.score import (
    EngagementTier,
    Route,
    assign_tiers,
    leverage,
    score_counterparty,
    winnability,
)
from engines.types import Counterparty, RelationshipRole as R
from tests import fixtures as fx

TODAY = fx.TODAY

#: Per-counterparty uplift, from engines.quality.uplift_tonnes over the fixture.
UPLIFT = {
    "bidfood": 60_000.0,
    "beef_co": 36_000.0,
    "dairy_co": 10_500.0,
    "charging": 4_200.0,
    "waste_co": 3_250.0,
    "starbucks": 3_500.0,
    "bakery": 800.0,
    "yum": 0.0,
    "applegreen": 0.0,
}


def _score(counterparty_id: str):
    return score_counterparty(
        fx.COUNTERPARTIES[counterparty_id],
        uplift_tco2e=UPLIFT[counterparty_id],
        annual_spend_gbp=fx.ANNUAL_SPEND[counterparty_id],
        today=TODAY,
    )


class Winnability(unittest.TestCase):
    def test_a_known_responder_scores_well(self):
        self.assertAlmostEqual(winnability(fx.BIDFOOD), 0.75)

    def test_a_small_supplier_carries_a_capability_penalty(self):
        # No positive features and below the employee threshold, so it lands
        # on the floor rather than at zero.
        self.assertAlmostEqual(winnability(fx.BAKERY), 0.05)

    def test_the_ceiling_holds_for_a_counterparty_with_every_feature(self):
        self.assertLessEqual(winnability(fx.DAIRY_CO), 0.95)

    def test_nobody_is_certain_and_nobody_is_hopeless(self):
        for counterparty in fx.COUNTERPARTIES.values():
            with self.subTest(counterparty=counterparty.id):
                self.assertGreaterEqual(winnability(counterparty), 0.05)
                self.assertLessEqual(winnability(counterparty), 0.95)


class Leverage(unittest.TestCase):
    def test_a_franchisor_holds_power_over_us_not_the_reverse(self):
        self.assertEqual(
            leverage(fx.YUM, annual_spend_gbp=0, today=TODAY), -1.0
        )

    def test_a_parent_company_is_also_dominant(self):
        self.assertEqual(
            leverage(fx.APPLEGREEN, annual_spend_gbp=0, today=TODAY), -1.0
        )

    def test_a_contractual_data_right_is_worth_real_leverage(self):
        self.assertGreater(
            leverage(fx.WASTE_CO, annual_spend_gbp=3_100_000, today=TODAY), 0.3
        )

    def test_leverage_never_exceeds_one(self):
        heavy = Counterparty(
            id="tiny",
            name="Tiny Supplier",
            roles=frozenset({R.SUPPLIER}),
            turnover_gbp=100_000,
            contractual_data_right=True,
            contract_end=date(2026, 9, 20),
        )
        self.assertLessEqual(
            leverage(heavy, annual_spend_gbp=90_000, today=TODAY), 1.0
        )

    def test_an_imminent_renewal_adds_more_than_a_distant_one(self):
        soon = Counterparty(
            id="a",
            name="A",
            roles=frozenset({R.SUPPLIER}),
            turnover_gbp=1_000_000,
            contract_end=date(2026, 10, 1),
        )
        later = Counterparty(
            id="b",
            name="B",
            roles=frozenset({R.SUPPLIER}),
            turnover_gbp=1_000_000,
            contract_end=date(2027, 8, 1),
        )
        self.assertGreater(
            leverage(soon, annual_spend_gbp=10_000, today=TODAY),
            leverage(later, annual_spend_gbp=10_000, today=TODAY),
        )


class Routing(unittest.TestCase):
    """Layer 2 acceptance 9: negative dependence gets a realistic route."""

    def test_a_publishing_franchisor_is_taken_from_its_report(self):
        score = _score("yum")
        self.assertIs(score.route, Route.ACCEPT_PUBLISHED)
        self.assertEqual(score.score, 0.0)
        self.assertIn("publish", score.reason)

    def test_a_dominant_counterparty_that_publishes_nothing_goes_to_renewal(self):
        opaque = Counterparty(
            id="opaque",
            name="Opaque Franchisor",
            roles=frozenset({R.FRANCHISOR}),
            contract_end=date(2028, 1, 1),
        )
        score = score_counterparty(
            opaque, uplift_tco2e=5_000, annual_spend_gbp=0, today=TODAY
        )
        self.assertIs(score.route, Route.NEGOTIATE_AT_RENEWAL)
        self.assertIn("renewal", score.reason)

    def test_a_supplier_with_leverage_is_engaged_directly(self):
        score = _score("bidfood")
        self.assertIs(score.route, Route.ENGAGE_DIRECT)
        self.assertGreater(score.score, 0)
        self.assertIn("tCO2e", score.reason)

    def test_nothing_to_gain_means_no_request(self):
        score = score_counterparty(
            fx.BIDFOOD, uplift_tco2e=0.0, annual_spend_gbp=1_000, today=TODAY
        )
        self.assertIs(score.route, Route.USE_SECONDARY)
        self.assertIn("change nothing", score.reason)


class Tiering(unittest.TestCase):
    def setUp(self):
        self.scores = [_score(cid) for cid in fx.COUNTERPARTIES]
        self.tiers = assign_tiers(self.scores)

    def test_dominant_publishers_are_never_chased(self):
        self.assertIs(self.tiers["yum"], EngagementTier.T3_PUBLIC_ONLY)
        self.assertIs(self.tiers["starbucks"], EngagementTier.T3_PUBLIC_ONLY)
        self.assertIs(self.tiers["applegreen"], EngagementTier.T3_PUBLIC_ONLY)

    def test_the_largest_opportunity_takes_the_top_tier(self):
        self.assertIs(self.tiers["bidfood"], EngagementTier.T1_PRIMARY)

    def test_every_counterparty_is_tiered(self):
        self.assertEqual(set(self.tiers), set(fx.COUNTERPARTIES))

    def test_a_single_dominant_contributor_still_lands_in_the_top_tier(self):
        """Banding is on the share accounted for before each counterparty.

        Measured after, one counterparty carrying the whole population would
        fall to the bottom tier, which is the wrong way round.
        """
        only = Counterparty(
            id="only", name="Only", roles=frozenset({R.SUPPLIER}), turnover_gbp=1e6
        )
        score = score_counterparty(
            only, uplift_tco2e=1_000, annual_spend_gbp=200_000, today=TODAY
        )
        self.assertIs(assign_tiers([score])["only"], EngagementTier.T1_PRIMARY)

    def test_a_population_with_no_score_falls_to_secondary(self):
        score = score_counterparty(
            fx.BIDFOOD, uplift_tco2e=0.0, annual_spend_gbp=0, today=TODAY
        )
        self.assertIs(
            assign_tiers([score])["bidfood"], EngagementTier.T4_SECONDARY
        )


if __name__ == "__main__":
    unittest.main()
