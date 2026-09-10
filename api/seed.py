"""Seed a store with the Welcome-shaped demo: counterparties, figures,
engagements at various states, documents, and a review queue.

The data is the same fixture set the tests and the demo script use, so the
front end shows exactly what the engines were proved against.
"""

from __future__ import annotations

from datetime import date, timedelta

from engines.conflict import reported_vs_published
from engines.lifecycle import Engagement
from engines.types import EngagementState as S
from store import Store

__all__ = ["seed"]


def seed(store: Store, *, today: date = date(2026, 9, 10)) -> None:
    from tests import fixtures as fx  # the shared fixture set is the demo data

    store.ensure_organisation(fx.ORG, "Welcome-shaped operator")
    store.ensure_organisation(fx.OTHER_ORG, "Other client")
    for cp in fx.COUNTERPARTIES.values():
        store.save_counterparty(fx.ORG, cp)
    store.save_figures(fx.ORG, fx.REPORTING_PERIOD, fx.FIGURES, created_by="seed")
    for d in fx.DISCLOSURE_DOCUMENTS:
        if d.owner_org_id:
            store.save_document(d.owner_org_id, d)

    deadline = today + timedelta(weeks=14)
    walk = {
        "bidfood":   (S.IDENTIFIED, S.ENRICHED, S.SCOPED, S.CONTACTED),
        "starbucks": (S.IDENTIFIED, S.ENRICHED, S.SCOPED, S.CONTACTED, S.ENGAGED, S.RESPONDING),
        "dairy_co":  (S.IDENTIFIED, S.ENRICHED, S.SCOPED, S.CONTACTED, S.ENGAGED, S.RESPONDING, S.COMPLETE, S.VERIFIED),
        "beef_co":   (S.IDENTIFIED, S.ENRICHED, S.SCOPED),
        "bakery":    (S.IDENTIFIED, S.ENRICHED),
        "waste_co":  (S.IDENTIFIED,),
        "yum":       (S.IDENTIFIED, S.ENRICHED, S.SCOPED),
        "charging":  (),
        "applegreen": (S.IDENTIFIED, S.ENRICHED),
    }
    for cp_id, states in walk.items():
        if cp_id not in fx.COUNTERPARTIES:
            continue
        eng_id = f"eng_{cp_id}_{fx.REPORTING_PERIOD}"
        store.save_engagement(fx.ORG, Engagement(eng_id, cp_id, fx.REPORTING_PERIOD, deadline=deadline))
        at = today - timedelta(days=7 * len(states))
        for s in states:
            store.transition_engagement(fx.ORG, eng_id, s, actor="seed", trigger="seed", at=at)
            at += timedelta(days=7)

    store.save_proposal(fx.ORG, agent="resolver", kind="counterparty_match", confidence=0.86,
                        payload={"raw": "BIDFOOD LIMITED", "candidate": "bidfood", "evidence": "Companies House 01234567"})
    store.save_proposal(fx.ORG, agent="reader", kind="document_extract", confidence=0.72,
                        payload={"document_id": "vsme-bakery-2025", "field": "scope1_tco2e", "value": 1250.5, "snippet": "Scope 1 GHG emissions (gross) 1250.5"})
    store.save_conflict(fx.ORG, reported_vs_published(
        "Bidfood Scope 1+2 FY2025", 41_200, 38_900, reported_source="VSME return", published_source="Annual report 2025"))
