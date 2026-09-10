"""Observed response rates. Reported, ranked with a sample guard, never modelled."""

from __future__ import annotations

import unittest
from datetime import date

from engines.outcome import MIN_ATTEMPTS_TO_RANK, AttemptOutcome, prefill_effect, rates_by, recommend_order
from engines.types import ContactRung, RequestTemplate

SENT = date(2026, 6, 1)


def _attempt(channel="email", rung=ContactRung.DAY_TO_DAY, prefilled=True, responded=True, hours=48.0, sector=None):
    return AttemptOutcome("x", channel, rung, prefilled, RequestTemplate.VSME, SENT, responded, hours, sector)


class Rates(unittest.TestCase):
    def test_rates_are_computed_per_value_best_first(self):
        outcomes = [_attempt(channel="email", responded=True)] * 3 + [_attempt(channel="portal", responded=False)] * 3
        rates = rates_by(outcomes, "channel")
        self.assertEqual([r.value for r in rates], ["email", "portal"])
        self.assertEqual(rates[0].rate, 1.0)
        self.assertEqual(rates[1].rate, 0.0)

    def test_median_hours_only_counts_responses(self):
        outcomes = [_attempt(responded=True, hours=24), _attempt(responded=True, hours=72), _attempt(responded=False, hours=None)]
        rate = rates_by(outcomes, "channel")[0]
        self.assertEqual(rate.median_hours_to_response, 48)

    def test_a_sector_filter_narrows_the_sample(self):
        outcomes = [_attempt(sector="food", responded=True), _attempt(sector="waste", responded=False)]
        self.assertEqual(rates_by(outcomes, "channel", sector="food")[0].rate, 1.0)

    def test_an_unknown_feature_is_refused(self):
        with self.assertRaises(ValueError):
            rates_by([_attempt()], "colour")  # type: ignore[arg-type]


class Recommendation(unittest.TestCase):
    def test_well_sampled_options_are_ordered_by_observed_rate(self):
        outcomes = (
            [_attempt(channel="email", responded=False)] * MIN_ATTEMPTS_TO_RANK
            + [_attempt(channel="phone", responded=True)] * MIN_ATTEMPTS_TO_RANK
        )
        self.assertEqual(recommend_order(outcomes, "channel", ["email", "phone"]), ["phone", "email"])

    def test_under_sampled_options_keep_the_callers_order_and_come_last(self):
        outcomes = [_attempt(channel="email", responded=True)] * MIN_ATTEMPTS_TO_RANK + [_attempt(channel="phone", responded=True)]
        self.assertEqual(recommend_order(outcomes, "channel", ["portal", "phone", "email"]), ["email", "portal", "phone"])

    def test_no_evidence_means_the_callers_order(self):
        self.assertEqual(recommend_order([], "channel", ["a", "b"]), ["a", "b"])


class PrefillEffect(unittest.TestCase):
    def test_the_lift_is_measured_only_when_both_arms_have_a_sample(self):
        outcomes = [_attempt(prefilled=True, responded=True)] * MIN_ATTEMPTS_TO_RANK + [_attempt(prefilled=False, responded=False)] * MIN_ATTEMPTS_TO_RANK
        self.assertAlmostEqual(prefill_effect(outcomes), 1.0)

    def test_an_under_sampled_arm_yields_no_claim(self):
        outcomes = [_attempt(prefilled=True, responded=True)] * MIN_ATTEMPTS_TO_RANK + [_attempt(prefilled=False, responded=False)]
        self.assertIsNone(prefill_effect(outcomes))


if __name__ == "__main__":
    unittest.main()
