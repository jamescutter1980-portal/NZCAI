"""The store: organisation isolation, append-only figures, atomic transitions."""

from __future__ import annotations

import re
import sqlite3
import unittest
from datetime import date
from pathlib import Path

from engines.conflict import reported_vs_published
from engines.lifecycle import Engagement, InvalidTransition
from engines.outcome import AttemptOutcome
from engines.types import (
    Category, Confidentiality, ContactRung, DeclineReason, Document, DocumentType,
    EngagementState as S, Figure, RequestTemplate, Tier,
)
from store import NotFound, Store
from tests import fixtures as fx

AT = date(2026, 9, 10)


def _fig(tco2e: float = 100.0, **kw) -> Figure:
    base = dict(category=Category.C1_PURCHASED_GOODS, tco2e=tco2e, tier=Tier.D,
                factor_source="test", factor_version="1")
    base.update(kw)
    return Figure(**base)


class Base(unittest.TestCase):
    def setUp(self):
        self.s = Store.open()
        self.s.ensure_organisation(fx.ORG, "Welcome-shaped")
        self.s.ensure_organisation(fx.OTHER_ORG, "Other client")

    def tearDown(self):
        self.s.close()


class Isolation(Base):
    """No method returns another organisation's rows."""

    def test_counterparties_are_scoped(self):
        self.s.save_counterparty(fx.ORG, fx.BIDFOOD)
        self.assertEqual([c.id for c in self.s.list_counterparties(fx.ORG)], ["bidfood"])
        self.assertEqual(self.s.list_counterparties(fx.OTHER_ORG), [])
        with self.assertRaises(NotFound):
            self.s.get_counterparty(fx.OTHER_ORG, "bidfood")

    def test_figures_are_scoped(self):
        self.s.save_figures(fx.ORG, 2026, [_fig()])
        self.assertEqual(len(self.s.list_figures(fx.ORG, 2026)), 1)
        self.assertEqual(self.s.list_figures(fx.OTHER_ORG, 2026), [])

    def test_engagements_and_their_audit_trails_are_scoped(self):
        self.s.save_counterparty(fx.ORG, fx.BIDFOOD)
        self.s.save_engagement(fx.ORG, Engagement("e1", "bidfood", 2026))
        self.s.transition_engagement(fx.ORG, "e1", S.IDENTIFIED, actor="t", trigger="t", at=AT)
        with self.assertRaises(NotFound):
            self.s.get_engagement(fx.OTHER_ORG, "e1")
        self.assertEqual(self.s.audit_trail(fx.OTHER_ORG, "e1"), [])

    def test_a_missing_row_and_another_orgs_row_raise_the_same_error(self):
        self.s.save_counterparty(fx.ORG, fx.BIDFOOD)
        with self.assertRaises(NotFound) as other:
            self.s.get_counterparty(fx.OTHER_ORG, "bidfood")
        with self.assertRaises(NotFound) as missing:
            self.s.get_counterparty(fx.ORG, "nobody")
        self.assertEqual(type(other.exception), type(missing.exception))


class AppendOnlyFigures(Base):
    def test_a_correction_inserts_and_supersedes_rather_than_updating(self):
        [old_id] = self.s.save_figures(fx.ORG, 2026, [_fig(100)])
        new_id = self.s.supersede_figure(fx.ORG, old_id, _fig(120), actor="reviewer")
        active = self.s.list_figures(fx.ORG, 2026)
        self.assertEqual(len(active), 1)
        self.assertAlmostEqual(active[0].tco2e, 120)
        everything = self.s.list_figures(fx.ORG, 2026, include_superseded=True)
        self.assertEqual(len(everything), 2)
        chain = self.s.figure_lineage(fx.ORG, new_id)
        self.assertEqual([c["id"] for c in chain], [old_id, new_id])
        self.assertEqual(chain[0]["status"], "superseded")

    def test_a_superseded_figure_cannot_be_superseded_again(self):
        [old_id] = self.s.save_figures(fx.ORG, 2026, [_fig()])
        self.s.supersede_figure(fx.ORG, old_id, _fig(), actor="r")
        with self.assertRaises(ValueError):
            self.s.supersede_figure(fx.ORG, old_id, _fig(), actor="r")

    def test_updating_a_figure_in_place_is_refused_by_the_database(self):
        [fid] = self.s.save_figures(fx.ORG, 2026, [_fig()])
        with self.assertRaises(sqlite3.IntegrityError):
            self.s._c.execute("update figure set tco2e = 1 where id = ?", (fid,))

    def test_deleting_a_figure_is_refused_by_the_database(self):
        [fid] = self.s.save_figures(fx.ORG, 2026, [_fig()])
        with self.assertRaises(sqlite3.IntegrityError):
            self.s._c.execute("delete from figure where id = ?", (fid,))

    def test_lineage_fields_survive_the_round_trip(self):
        f = _fig(activity_quantity=1000.0, activity_unit="kWh", factor_key="electricity_uk_grid",
                 factor_kgco2e=0.177, method_label="1,000 kWh x grid", entity_id="uk")
        self.s.save_figures(fx.ORG, 2026, [f])
        [back] = self.s.list_figures(fx.ORG, 2026)
        self.assertTrue(back.has_lineage)
        self.assertEqual(back.factor_key, "electricity_uk_grid")
        self.assertEqual(back.entity_id, "uk")


class AtomicTransitions(Base):
    def setUp(self):
        super().setUp()
        self.s.save_counterparty(fx.ORG, fx.BIDFOOD)
        self.s.save_engagement(fx.ORG, Engagement("e1", "bidfood", 2026))

    def test_a_transition_writes_the_state_and_the_audit_row_together(self):
        moved, row = self.s.transition_engagement(fx.ORG, "e1", S.IDENTIFIED, actor="resolver", trigger="companies_house", at=AT)
        self.assertIs(moved.state, S.IDENTIFIED)
        self.assertIs(self.s.get_engagement(fx.ORG, "e1").state, S.IDENTIFIED)
        trail = self.s.audit_trail(fx.ORG, "e1")
        self.assertEqual(len(trail), 1)
        self.assertEqual(trail[0].actor, "resolver")
        self.assertIs(trail[0].to_state, S.IDENTIFIED)

    def test_an_invalid_transition_writes_nothing(self):
        with self.assertRaises(InvalidTransition):
            self.s.transition_engagement(fx.ORG, "e1", S.VERIFIED, actor="t", trigger="t", at=AT)
        self.assertIs(self.s.get_engagement(fx.ORG, "e1").state, S.UNIDENTIFIED)
        self.assertEqual(self.s.audit_trail(fx.ORG, "e1"), [])

    def test_a_refusal_needs_its_reason_to_be_persisted(self):
        for to in (S.IDENTIFIED, S.ENRICHED, S.SCOPED, S.CONTACTED):
            self.s.transition_engagement(fx.ORG, "e1", to, actor="t", trigger="t", at=AT)
        with self.assertRaises(InvalidTransition):
            self.s.transition_engagement(fx.ORG, "e1", S.DECLINED, actor="t", trigger="t", at=AT)
        moved, _ = self.s.transition_engagement(fx.ORG, "e1", S.DECLINED, actor="t", trigger="reply", at=AT, decline_reason=DeclineReason.VSME_CAP)
        self.assertIs(self.s.get_engagement(fx.ORG, "e1").decline_reason, DeclineReason.VSME_CAP)

    def test_the_audit_trail_is_append_only(self):
        self.s.transition_engagement(fx.ORG, "e1", S.IDENTIFIED, actor="t", trigger="t", at=AT)
        with self.assertRaises(sqlite3.IntegrityError):
            self.s._c.execute("delete from audit_row")

    def test_engagements_can_be_listed_by_state(self):
        self.s.transition_engagement(fx.ORG, "e1", S.IDENTIFIED, actor="t", trigger="t", at=AT)
        self.assertEqual(len(self.s.list_engagements(fx.ORG, state=S.IDENTIFIED)), 1)
        self.assertEqual(self.s.list_engagements(fx.ORG, state=S.VERIFIED), [])


class DocumentsAndDisclosure(Base):
    def setUp(self):
        super().setUp()
        for d in fx.DISCLOSURE_DOCUMENTS:
            if d.owner_org_id:
                self.s.save_document(d.owner_org_id, d)

    def test_the_owner_sees_everything_it_holds(self):
        self.assertEqual(len(self.s.list_documents(fx.ORG)), 4)

    def test_another_client_sees_only_public_and_consented_material(self):
        seen = {d.id for d in self.s.visible_documents(to_org_id=fx.OTHER_ORG)}
        self.assertEqual(seen, {fx.REPORT_CURRENT.id, fx.VSME_CONSENTED.id})

    def test_a_third_client_sees_only_public_material(self):
        seen = {d.id for d in self.s.visible_documents(to_org_id="org_third")}
        self.assertEqual(seen, {fx.REPORT_CURRENT.id})

    def test_the_round_trip_preserves_consent_and_ownership(self):
        [doc] = [d for d in self.s.list_documents(fx.ORG) if d.id == fx.VSME_CONSENTED.id]
        self.assertEqual(doc.consented_org_ids, frozenset({fx.OTHER_ORG}))
        self.assertEqual(doc.owner_org_id, fx.ORG)
        self.assertIs(doc.confidentiality, Confidentiality.CONSENTED_REUSE)


class ConflictsAndProposals(Base):
    def test_a_conflict_is_stored_open_and_decided_once(self):
        c = reported_vs_published("Scope 1", 9_500, 12_000, reported_source="q", published_source="r")
        cid = self.s.save_conflict(fx.ORG, c)
        self.assertEqual(len(self.s.list_conflicts(fx.ORG)), 1)
        self.s.decide_conflict(fx.ORG, cid, decision="use published", decided_by="james")
        self.assertEqual(self.s.list_conflicts(fx.ORG), [])
        with self.assertRaises(NotFound):
            self.s.decide_conflict(fx.ORG, cid, decision="again", decided_by="james")

    def test_a_proposal_waits_for_a_person(self):
        pid = self.s.save_proposal(fx.ORG, agent="resolver", kind="counterparty_match",
                                   payload={"raw": "BIDFOOD LTD", "candidate": "bidfood"}, confidence=0.9)
        [pending] = self.s.list_proposals(fx.ORG)
        self.assertEqual(pending.payload["candidate"], "bidfood")
        decided = self.s.decide_proposal(fx.ORG, pid, accept=True, decided_by="james")
        self.assertEqual(decided.status, "accepted")
        self.assertEqual(self.s.list_proposals(fx.ORG), [])
        self.assertEqual(self.s.list_proposals(fx.OTHER_ORG, status="accepted"), [])

    def test_outcomes_round_trip(self):
        o = AttemptOutcome("bidfood", "email", ContactRung.DAY_TO_DAY, True, RequestTemplate.VSME, AT, True, 36.0, "food")
        self.s.save_outcome(fx.ORG, o)
        [back] = self.s.list_outcomes(fx.ORG)
        self.assertEqual(back, o)


class SchemaAgreement(unittest.TestCase):
    """The Postgres migration's CHECK lists must match the enums in engines.types."""

    def _checks(self, column: str) -> set[str]:
        sql = Path("store/migrations/0001_scope3_core.sql").read_text()
        m = re.search(rf"{column}\s+text[^,]*?check \({column} in \(([^)]*)\)", sql, re.S)
        self.assertIsNotNone(m, f"no CHECK found for {column}")
        return {v.strip().strip("'") for v in m.group(1).split(",")}

    def test_engagement_states_agree(self):
        self.assertEqual(self._checks("state"), {s.value for s in S})

    def test_document_types_agree(self):
        self.assertEqual(self._checks("doc_type"), {d.value for d in DocumentType})

    def test_confidentiality_bases_agree(self):
        self.assertEqual(self._checks("confidentiality"), {c.value for c in Confidentiality})

    def test_decline_reasons_agree(self):
        self.assertEqual(self._checks("decline_reason"), {d.value for d in DeclineReason})

    def test_categories_agree(self):
        self.assertEqual(self._checks("category"), {c.value for c in Category})

    def test_tiers_agree(self):
        self.assertEqual(self._checks("tier"), {t.value for t in Tier})


if __name__ == "__main__":
    unittest.main()
