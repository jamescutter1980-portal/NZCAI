"""Confidentiality enforcement. Covers Layer 2 hard constraint 4.

The case that matters is a consultancy acting for several clients in the same
supply chain. An unenforced label there is not untidiness, it is a breach.
"""

from __future__ import annotations

import unittest

from engines.disclosure import (
    DisclosureRefused,
    assert_disclosable,
    disclosable,
    may_disclose,
    withheld,
)
from engines.types import Confidentiality, Document, DocumentType
from tests import fixtures as fx


class PublicBasis(unittest.TestCase):
    def test_a_published_report_is_open_to_anyone(self):
        for requester in (fx.ORG, fx.OTHER_ORG, None):
            with self.subTest(requester=requester):
                decision = may_disclose(fx.REPORT_CURRENT, to_org_id=requester)
                self.assertTrue(decision.allowed)

    def test_a_public_document_needs_no_attribution(self):
        orphan_but_public = Document(
            id="doc_pub",
            counterparty_id="dairy_co",
            doc_type=DocumentType.CDP_RESPONSE,
            issue_date=fx.TODAY,
            confidentiality=Confidentiality.PUBLIC,
        )
        self.assertTrue(may_disclose(orphan_but_public, to_org_id=None).allowed)


class OwnerAlwaysSees(unittest.TestCase):
    def test_the_holding_client_sees_its_own_documents(self):
        for document in fx.DISCLOSURE_DOCUMENTS:
            if document.owner_org_id is None:
                continue
            with self.subTest(document=document.id):
                self.assertTrue(may_disclose(document, to_org_id=fx.ORG).allowed)


class OtherClientsAreBlocked(unittest.TestCase):
    def test_an_nda_does_not_extend_to_another_client(self):
        decision = may_disclose(fx.PCF_UNDER_NDA, to_org_id=fx.OTHER_ORG)
        self.assertFalse(decision.allowed)
        self.assertIs(decision.basis, Confidentiality.NDA)
        self.assertIn("does not extend", decision.reason)

    def test_client_only_material_stays_with_that_client(self):
        decision = may_disclose(fx.INVOICE, to_org_id=fx.OTHER_ORG)
        self.assertFalse(decision.allowed)
        self.assertIn("another client", decision.reason)


class ConsentedReuse(unittest.TestCase):
    def test_a_named_organisation_may_see_it(self):
        decision = may_disclose(fx.VSME_CONSENTED, to_org_id=fx.OTHER_ORG)
        self.assertTrue(decision.allowed)
        self.assertIn("consented", decision.reason)

    def test_an_organisation_outside_the_consent_may_not(self):
        decision = may_disclose(fx.VSME_CONSENTED, to_org_id="org_third_client")
        self.assertFalse(decision.allowed)
        self.assertIn("Obtain", decision.reason)


class FailsClosed(unittest.TestCase):
    def test_an_unattributed_document_is_disclosed_to_nobody(self):
        for requester in (fx.ORG, fx.OTHER_ORG, None):
            with self.subTest(requester=requester):
                self.assertFalse(
                    may_disclose(fx.UNATTRIBUTED, to_org_id=requester).allowed
                )

    def test_the_refusal_says_what_to_do_about_it(self):
        decision = may_disclose(fx.UNATTRIBUTED, to_org_id=fx.ORG)
        self.assertIn("Attribute it", decision.reason)

    def test_an_unauthenticated_request_gets_nothing_but_public_material(self):
        allowed = disclosable(fx.DISCLOSURE_DOCUMENTS, to_org_id=None)
        self.assertEqual([d.id for d in allowed], [fx.REPORT_CURRENT.id])


class Filtering(unittest.TestCase):
    def test_the_holding_client_sees_everything_it_is_attributed(self):
        allowed = disclosable(fx.DISCLOSURE_DOCUMENTS, to_org_id=fx.ORG)
        self.assertNotIn(fx.UNATTRIBUTED.id, [d.id for d in allowed])
        self.assertEqual(len(allowed), len(fx.DISCLOSURE_DOCUMENTS) - 1)

    def test_another_client_sees_only_public_and_consented_material(self):
        allowed = disclosable(fx.DISCLOSURE_DOCUMENTS, to_org_id=fx.OTHER_ORG)
        self.assertEqual(
            sorted(d.id for d in allowed),
            sorted([fx.REPORT_CURRENT.id, fx.VSME_CONSENTED.id]),
        )

    def test_order_is_preserved_so_an_appendix_does_not_reshuffle(self):
        allowed = disclosable(fx.DISCLOSURE_DOCUMENTS, to_org_id=fx.ORG)
        original = [d.id for d in fx.DISCLOSURE_DOCUMENTS if d in allowed]
        self.assertEqual([d.id for d in allowed], original)


class Withheld(unittest.TestCase):
    def test_the_reviewer_is_told_what_was_held_back_and_why(self):
        held = withheld(fx.DISCLOSURE_DOCUMENTS, to_org_id=fx.OTHER_ORG)
        held_ids = {d.id for d, _ in held}
        self.assertEqual(held_ids, {fx.INVOICE.id, fx.PCF_UNDER_NDA.id, fx.UNATTRIBUTED.id})
        for _, decision in held:
            self.assertFalse(decision.allowed)
            self.assertTrue(decision.reason)

    def test_nothing_is_withheld_from_a_fully_entitled_requester(self):
        held = withheld([fx.REPORT_CURRENT, fx.INVOICE], to_org_id=fx.ORG)
        self.assertEqual(held, [])


class Assertion(unittest.TestCase):
    def test_a_permitted_document_passes_through(self):
        self.assertIs(
            assert_disclosable(fx.INVOICE, to_org_id=fx.ORG), fx.INVOICE
        )

    def test_a_refused_document_raises_with_the_reason(self):
        with self.assertRaises(DisclosureRefused) as caught:
            assert_disclosable(fx.PCF_UNDER_NDA, to_org_id=fx.OTHER_ORG)
        self.assertIn("not disclosable", str(caught.exception))
        self.assertIn("does not extend", str(caught.exception))

    def test_the_message_names_an_unattributed_requester_readably(self):
        with self.assertRaises(DisclosureRefused) as caught:
            assert_disclosable(fx.INVOICE, to_org_id=None)
        self.assertIn("unattributed requester", str(caught.exception))


class DecisionIsTruthy(unittest.TestCase):
    def test_a_decision_reads_naturally_in_a_guard(self):
        self.assertTrue(bool(may_disclose(fx.REPORT_CURRENT, to_org_id=fx.ORG)))
        self.assertFalse(bool(may_disclose(fx.UNATTRIBUTED, to_org_id=fx.ORG)))

    def test_every_basis_is_covered_by_a_rule(self):
        """Adding a basis without a rule must fail closed, not fall through."""
        for basis in Confidentiality:
            document = Document(
                id=f"doc_{basis.value}",
                counterparty_id="bidfood",
                doc_type=DocumentType.INVOICE,
                issue_date=fx.TODAY,
                confidentiality=basis,
                owner_org_id=fx.ORG,
            )
            with self.subTest(basis=basis):
                decision = may_disclose(document, to_org_id="org_stranger")
                self.assertIsInstance(decision.allowed, bool)
                self.assertTrue(decision.reason)


if __name__ == "__main__":
    unittest.main()
