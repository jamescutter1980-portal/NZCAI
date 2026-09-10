"""Cadence, templates and fatigue. Covers Layer 2 acceptance criteria 6 and 8."""

from __future__ import annotations

import unittest
from datetime import date, timedelta

from engines.plan import (
    CADENCE,
    MIN_CONTACT_GAP_DAYS,
    batch_needs,
    build_schedule,
    may_contact,
    next_step,
    template_for,
)
from engines.types import ContactRung, RequestTemplate
from tests import fixtures as fx

DEADLINE = date(2027, 1, 31)


class Schedule(unittest.TestCase):
    def setUp(self):
        self.schedule = build_schedule(DEADLINE)

    def test_the_wave_is_planned_backwards_from_the_deadline(self):
        self.assertEqual(len(self.schedule), len(CADENCE))
        self.assertEqual(self.schedule[0].weeks_before, 16)
        self.assertEqual(self.schedule[0].due, DEADLINE - timedelta(weeks=16))
        self.assertEqual(self.schedule[-1].due, DEADLINE - timedelta(weeks=2))

    def test_the_last_resort_still_lands_before_the_deadline(self):
        self.assertLess(self.schedule[-1].due, DEADLINE)
        self.assertTrue(self.schedule[-1].is_fallback)

    def test_escalation_walks_up_the_ladder(self):
        rungs = [s.rung for s in self.schedule]
        self.assertEqual(rungs[0], ContactRung.DAY_TO_DAY)
        self.assertEqual(rungs[2], ContactRung.ACCOUNT_MANAGER)
        self.assertEqual(rungs[3], ContactRung.SUSTAINABILITY_LEAD)
        self.assertEqual(rungs[4], ContactRung.COMMERCIAL)

    def test_intervals_widen_rather_than_narrow(self):
        gaps = [
            (self.schedule[i].due - self.schedule[i - 1].due).days
            for i in range(1, len(self.schedule))
        ]
        self.assertTrue(all(g > 0 for g in gaps))


class NextStep(unittest.TestCase):
    def setUp(self):
        self.schedule = build_schedule(DEADLINE)

    def test_before_the_wave_opens_the_first_contact_is_next(self):
        step = next_step(self.schedule, DEADLINE - timedelta(weeks=20))
        self.assertIsNotNone(step)
        self.assertEqual(step.weeks_before, 16)

    def test_a_late_start_resumes_at_the_rung_reached_not_the_first_missed(self):
        """A programme that begins late must not replay the whole ladder."""
        step = next_step(self.schedule, DEADLINE - timedelta(weeks=5))
        self.assertIsNotNone(step)
        self.assertEqual(step.weeks_before, 6)

    def test_once_the_fallback_has_passed_nothing_is_pending(self):
        self.assertIsNone(next_step(self.schedule, DEADLINE))

    def test_an_empty_schedule_has_no_next_step(self):
        self.assertIsNone(next_step([], DEADLINE))


class Templates(unittest.TestCase):
    """Layer 2 acceptance 6: a small supplier is never over-asked."""

    def test_a_supplier_below_the_threshold_is_asked_in_the_sme_standard(self):
        self.assertIs(template_for(fx.BAKERY), RequestTemplate.VSME)

    def test_the_sme_cap_holds_even_when_we_want_product_footprints(self):
        self.assertIs(
            template_for(fx.BAKERY, needs_product_footprints=True),
            RequestTemplate.VSME,
        )

    def test_an_unknown_employee_count_is_treated_as_small(self):
        unknown = fx.BIDFOOD.__class__(
            id="unknown", name="Unknown Ltd", roles=fx.BIDFOOD.roles
        )
        self.assertIs(template_for(unknown), RequestTemplate.VSME)

    def test_a_large_supplier_gets_the_category_template(self):
        self.assertIs(template_for(fx.BIDFOOD), RequestTemplate.GHG_CATEGORY)

    def test_product_footprints_are_asked_for_over_pact(self):
        self.assertIs(
            template_for(fx.BIDFOOD, needs_product_footprints=True),
            RequestTemplate.PACT,
        )


class Fatigue(unittest.TestCase):
    def test_a_counterparty_never_contacted_may_be_contacted(self):
        self.assertTrue(may_contact(None, fx.TODAY))

    def test_a_recent_contact_blocks_another_ask(self):
        recent = fx.TODAY - timedelta(days=MIN_CONTACT_GAP_DAYS - 1)
        self.assertFalse(may_contact(recent, fx.TODAY))

    def test_the_gap_applies_across_clients_not_within_one(self):
        older = fx.TODAY - timedelta(days=MIN_CONTACT_GAP_DAYS)
        self.assertTrue(may_contact(older, fx.TODAY))


class Batching(unittest.TestCase):
    def test_several_needs_become_one_request_per_counterparty(self):
        batched = batch_needs(
            [
                ("bidfood", "scope_1"),
                ("bidfood", "scope_2"),
                ("bidfood", "scope_1"),
                ("beef_co", "product_footprints"),
            ]
        )
        self.assertEqual(set(batched), {"bidfood", "beef_co"})
        self.assertEqual(batched["bidfood"], ["scope_1", "scope_2"])

    def test_nothing_outstanding_produces_no_requests(self):
        self.assertEqual(batch_needs([]), {})


if __name__ == "__main__":
    unittest.main()
