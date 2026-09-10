"""Deterministic engines for the NZC AI Scope 3 modules.

Every number in a client deliverable is computed here. No model call sits on
the path to a figure: agents resolve, enrich, draft, extract, rank and flag,
and a human confirms, but the arithmetic lives in this package and is covered
by tests derived from the acceptance criteria in the briefs.

Vocabulary
    types        shared enums and dataclasses, mirrored in the database schema

Calculation (Layer 1)
    factors      the emission factor library, versioned, loaded from CSV
    activity     quantity times factor, tier C
    eeio         spend times sector factor, deflated, tier D
    spend_map    ledger line to sector, rule-driven, with exclusions
    fuel_sold    category 11 for fuel retailers, and resold electricity
    partner      supplier-reported allocations and product footprints, tiers B and A
    boundary     which scope or category an outlet's activity lands in
    leased       categories 13, 8 and 14 from outlet energy via the boundary rules
    franchise    per-outlet packs for reporting upward to a franchisor
    screen       the annual fifteen-category relevance screen
    quality      method tiers, the ESRS primary/secondary split, trajectory
    coverage     SBTi near-term, exclusion, category 11 and alignment tests
    hotspots     ranking, and what-if levers that never touch the record
    consolidate  entity roll-up for a parent's statement

Engagement (Layer 2)
    resolve      ledger names to legal entities and their group root
    scope        what is still needed from a counterparty, after what we hold
    lifecycle    the engagement state machine
    score        who to chase, in what order, and who not to chase at all
    plan         cadence, the escalation ladder, template choice, fatigue control
    outcome      observed response rates by how we asked
    validity     document expiry and the lapse detection that re-opens chases
    conflict     disagreements between what a counterparty tells us and publishes
    disclosure   whether a document may be shown to a given organisation

Specification: docs/product/nzc-ai-scope-3-brief.md
               docs/product/nzc-ai-scope-3-engagement-brief.md
"""

from __future__ import annotations

from . import (
    activity,
    boundary,
    conflict,
    consolidate,
    coverage,
    disclosure,
    eeio,
    factors,
    franchise,
    fuel_sold,
    hotspots,
    leased,
    lifecycle,
    outcome,
    partner,
    plan,
    quality,
    resolve,
    scope,
    score,
    screen,
    spend_map,
    types,
    validity,
)

__all__ = [
    "activity",
    "boundary",
    "conflict",
    "consolidate",
    "coverage",
    "disclosure",
    "eeio",
    "factors",
    "franchise",
    "fuel_sold",
    "hotspots",
    "leased",
    "lifecycle",
    "outcome",
    "partner",
    "plan",
    "quality",
    "resolve",
    "scope",
    "score",
    "screen",
    "spend_map",
    "types",
    "validity",
]

__version__ = "0.2.0"
