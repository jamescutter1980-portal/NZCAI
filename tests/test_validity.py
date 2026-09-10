"""Document validity and lapse detection. Covers Layer 2 acceptance criterion 7."""

from __future__ import annotations

import unittest
from datetime import date

from engines.validity import (
    EXPIRY_WARNING_DAYS,
    expires_within,
    lapsed,
    status,
)
from engines.types import Document, DocumentStatus, DocumentType
from tests import fixtures as fx

TODAY = fx.TODAY


class StatedExpiry(unittest.TestCase):
    def test_a_certificate_past_its_date_is_expired(self):
        self.assertIs(status(fx.ISO_CERT_EXPIRED, TODAY), DocumentStatus.EXPIRED)

    def test_a_certificate_inside_the_warning_window_is_stale(self):
        # Expires 1 November 2026, evaluated on 10 September 2026.
        self.assertIs(status(fx.ISO_CERT_EXPIRING, TODAY), DocumentStatus.STALE)

    def test_a_certificate_well_ahead_of_its_date_is_current(self):
        far = Document(
            id="doc_far",
            counterparty_id="x",
            doc_type=DocumentType.ISO_CERTIFICATE,
            issue_date=date(2026, 1, 1),
            valid_to=date(2029, 1, 1),
        )
        self.assertIs(status(far, TODAY), DocumentStatus.CURRENT)

    def test_a_stated_date_overrides_the_implicit_rule_for_its_type(self):
        # A report would implicitly last fifteen months, but a stated expiry
        # is more authoritative than any default we pick.
        dated = Document(
            id="doc_dated",
            counterparty_id="x",
            doc_type=DocumentType.SUSTAINABILITY_REPORT,
            issue_date=date(2026, 8, 1),
            valid_to=date(2026, 8, 31),
        )
        self.assertIs(status(dated, TODAY), DocumentStatus.EXPIRED)


class ImplicitValidity(unittest.TestCase):
    def test_a_recent_report_is_current(self):
        self.assertIs(status(fx.REPORT_CURRENT, TODAY), DocumentStatus.CURRENT)

    def test_a_report_past_fifteen_months_is_stale(self):
        self.assertIs(status(fx.REPORT_STALE, TODAY), DocumentStatus.STALE)

    def test_a_utility_bill_ages_out_in_three_months(self):
        self.assertIs(status(fx.UTILITY_BILL_STALE, TODAY), DocumentStatus.STALE)

    def test_a_transactional_document_never_ages_out(self):
        self.assertIs(status(fx.INVOICE, TODAY), DocumentStatus.CURRENT)

    def test_the_month_count_does_not_round_a_partial_month_up(self):
        # Issued fifteen months ago less one day, so still inside validity.
        nearly = Document(
            id="doc_nearly",
            counterparty_id="x",
            doc_type=DocumentType.SUSTAINABILITY_REPORT,
            issue_date=date(2025, 6, 11),
        )
        self.assertIs(status(nearly, date(2026, 9, 10)), DocumentStatus.CURRENT)


class ExpiryWindow(unittest.TestCase):
    def test_an_undated_document_never_reports_an_expiry(self):
        self.assertFalse(expires_within(fx.REPORT_CURRENT, TODAY, 365))

    def test_a_document_inside_the_window_is_flagged(self):
        self.assertTrue(
            expires_within(fx.ISO_CERT_EXPIRING, TODAY, EXPIRY_WARNING_DAYS)
        )

    def test_an_already_expired_document_is_not_upcoming(self):
        self.assertFalse(expires_within(fx.ISO_CERT_EXPIRED, TODAY, 365))


class LapseList(unittest.TestCase):
    def setUp(self):
        self.lapses = lapsed(fx.DOCUMENTS, TODAY)
        self.by_id = {l.document.id: l for l in self.lapses}

    def test_current_documents_are_left_alone(self):
        self.assertNotIn(fx.REPORT_CURRENT.id, self.by_id)
        self.assertNotIn(fx.INVOICE.id, self.by_id)

    def test_expired_evidence_ranks_above_merely_ageing_evidence(self):
        self.assertIs(self.lapses[0].status, DocumentStatus.EXPIRED)
        self.assertEqual(self.lapses[0].document.id, fx.ISO_CERT_EXPIRED.id)

    def test_each_lapse_explains_itself_in_words_a_person_can_act_on(self):
        expired = self.by_id[fx.ISO_CERT_EXPIRED.id]
        self.assertIn("Expired on", expired.reason)
        self.assertIn("unevidenced", expired.reason)

        ageing = self.by_id[fx.REPORT_STALE.id]
        self.assertIn("15-month", ageing.reason)

    def test_an_expiring_certificate_names_its_date(self):
        expiring = self.by_id[fx.ISO_CERT_EXPIRING.id]
        self.assertIn("Nov 2026", expiring.reason)
        self.assertIn("warning window", expiring.reason)

    def test_nothing_to_chase_returns_an_empty_list(self):
        self.assertEqual(lapsed([], TODAY), [])


if __name__ == "__main__":
    unittest.main()
