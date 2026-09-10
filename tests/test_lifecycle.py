"""The engagement state machine. Covers Layer 2 acceptance criteria 6 and 7."""

from __future__ import annotations

import unittest
from datetime import date

from engines.lifecycle import (
    Engagement,
    InvalidTransition,
    can_transition,
    is_open,
    transition,
)
from engines.types import DeclineReason, EngagementState as S

AT = date(2026, 9, 10)


def _new(state: S = S.UNIDENTIFIED) -> Engagement:
    return Engagement(
        id="eng_1", counterparty_id="bidfood", period=2026, state=state
    )


class HappyPath(unittest.TestCase):
    def test_an_engagement_walks_from_unidentified_to_verified(self):
        engagement = _new()
        rows = []
        for to in (
            S.IDENTIFIED,
            S.ENRICHED,
            S.SCOPED,
            S.CONTACTED,
            S.ENGAGED,
            S.RESPONDING,
            S.COMPLETE,
            S.VERIFIED,
        ):
            engagement, row = transition(
                engagement, to, actor="tester", trigger="test", at=AT
            )
            rows.append(row)

        self.assertIs(engagement.state, S.VERIFIED)
        self.assertEqual(len(rows), 8)
        self.assertIs(rows[0].from_state, S.UNIDENTIFIED)
        self.assertIs(rows[-1].to_state, S.VERIFIED)

    def test_every_move_returns_an_audit_row_carrying_who_and_why(self):
        _, row = transition(
            _new(), S.IDENTIFIED, actor="resolver", trigger="companies_house", at=AT
        )
        self.assertEqual(row.actor, "resolver")
        self.assertEqual(row.trigger, "companies_house")
        self.assertEqual(row.at, AT)

    def test_the_original_engagement_is_not_mutated(self):
        before = _new()
        after, _ = transition(before, S.IDENTIFIED, actor="t", trigger="t", at=AT)
        self.assertIs(before.state, S.UNIDENTIFIED)
        self.assertIs(after.state, S.IDENTIFIED)


class AskLast(unittest.TestCase):
    def test_enrichment_can_satisfy_a_need_without_any_contact(self):
        """The whole point of asking last: some needs never become requests."""
        engagement = _new(S.SCOPED)
        self.assertTrue(can_transition(S.SCOPED, S.COMPLETE))
        moved, _ = transition(
            engagement,
            S.COMPLETE,
            actor="enricher",
            trigger="public_report_satisfied_all_fields",
            at=AT,
        )
        self.assertIs(moved.state, S.COMPLETE)
        self.assertEqual(moved.contact_attempts, 0)


class Escalation(unittest.TestCase):
    def test_re_contacting_stays_in_contacted_and_counts_the_attempt(self):
        engagement = _new(S.SCOPED)
        for _ in range(3):
            engagement, _ = transition(
                engagement, S.CONTACTED, actor="chaser", trigger="cadence", at=AT
            )
        self.assertIs(engagement.state, S.CONTACTED)
        self.assertEqual(engagement.contact_attempts, 3)


class Refusal(unittest.TestCase):
    """Layer 2 acceptance 6: a refusal is recorded with its reason."""

    def test_declining_without_a_reason_is_rejected(self):
        engagement = _new(S.CONTACTED)
        with self.assertRaises(InvalidTransition):
            transition(engagement, S.DECLINED, actor="reader", trigger="reply", at=AT)

    def test_a_lawful_vsme_refusal_is_recorded_as_such(self):
        engagement = _new(S.CONTACTED)
        moved, row = transition(
            engagement,
            S.DECLINED,
            actor="reader",
            trigger="reply",
            at=AT,
            decline_reason=DeclineReason.VSME_CAP,
        )
        self.assertIs(moved.decline_reason, DeclineReason.VSME_CAP)
        self.assertIs(row.to_state, S.DECLINED)

    def test_a_refusal_this_period_is_not_a_refusal_for_ever(self):
        self.assertTrue(can_transition(S.DECLINED, S.SCOPED))


class Lapse(unittest.TestCase):
    """Layer 2 acceptance 7: expiring evidence re-opens the chase."""

    def test_verified_evidence_can_lapse_and_be_scoped_again(self):
        engagement = _new(S.VERIFIED)
        lapsed, _ = transition(
            engagement,
            S.LAPSED,
            actor="watcher",
            trigger="iso_certificate_expired",
            at=AT,
        )
        self.assertIs(lapsed.state, S.LAPSED)
        self.assertTrue(is_open(S.LAPSED))
        self.assertTrue(can_transition(S.LAPSED, S.SCOPED))


class Guards(unittest.TestCase):
    def test_skipping_states_is_rejected(self):
        with self.assertRaises(InvalidTransition):
            transition(_new(), S.VERIFIED, actor="t", trigger="t", at=AT)

    def test_a_superseded_engagement_is_terminal(self):
        engagement = _new(S.VERIFIED)
        superseded, _ = transition(
            engagement, S.SUPERSEDED, actor="t", trigger="new_period", at=AT
        )
        with self.assertRaises(InvalidTransition):
            transition(superseded, S.SCOPED, actor="t", trigger="t", at=AT)

    def test_open_states_are_the_ones_needing_work(self):
        self.assertTrue(is_open(S.PARTIAL))
        self.assertTrue(is_open(S.SCOPED))
        self.assertFalse(is_open(S.VERIFIED))
        self.assertFalse(is_open(S.DECLINED))


if __name__ == "__main__":
    unittest.main()
