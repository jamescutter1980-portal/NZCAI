"""Deterministic engines for the NZC AI Scope 3 modules.

Every number in a client deliverable is computed here. No model call sits on
the path to a figure: agents resolve, enrich, draft, extract, rank and flag,
and a human confirms, but the arithmetic lives in this package and is covered
by tests derived from the acceptance criteria in the briefs.

Layout:
    types      shared enums and dataclasses, mirrored in the database schema
    boundary   which scope or Scope 3 category an outlet's activity lands in
    quality    method tiers, the ESRS primary/secondary split, trajectory
    coverage   SBTi near-term, exclusion, category 11 and alignment tests
    lifecycle  the engagement state machine
    score      who to chase, in what order, and who not to chase at all
    plan       cadence, the escalation ladder, template choice, fatigue control
    validity   document expiry and the lapse detection that re-opens chases
    conflict   disagreements between what a counterparty tells us and publishes

Specification: docs/product/nzc-ai-scope-3-brief.md
               docs/product/nzc-ai-scope-3-engagement-brief.md
"""

from __future__ import annotations

from . import boundary, conflict, coverage, lifecycle, plan, quality, score, types, validity

__all__ = [
    "boundary",
    "conflict",
    "coverage",
    "lifecycle",
    "plan",
    "quality",
    "score",
    "types",
    "validity",
]

__version__ = "0.1.0"
