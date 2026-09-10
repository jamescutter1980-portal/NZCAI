#!/usr/bin/env python3
"""End-to-end walkthrough of the Scope 3 engines on a motorway services operator.

Run from the repository root:

    python3 demo.py

Everything printed is computed by the engines in ``engines/``. Nothing is
hard-coded for display, so if a rule changes the output changes with it.
"""

from __future__ import annotations

from datetime import date

from engines.conflict import (
    certificate_scope_gap,
    collect,
    overallocation,
    reported_vs_published,
    unevidenced_renewable_claim,
)
from engines.coverage import (
    alignment_coverage,
    assess,
    food_sector_2030_gap,
    scope3_share,
)
from engines.plan import build_schedule, next_step, template_for
from engines.quality import category_breakdown, trajectory, uplift_tonnes
from engines.score import Route, assign_tiers, score_counterparty
from engines.types import Category
from engines.validity import lapsed
from tests import fixtures as fx

RULE = "─" * 78


def heading(number: str, title: str) -> None:
    print(f"\n{RULE}\n{number}  {title}\n{RULE}")


def main() -> None:
    print(f"\nNZC AI Scope 3 engines · demonstration run · {fx.TODAY:%d %B %Y}")
    print("Client shape: 32 motorway service areas, franchised catering, forecourt")

    # ------------------------------------------------------------------
    heading("1", "THE INVENTORY")
    rows = category_breakdown(fx.FIGURES)
    print(f"{'Cat':>4}  {'tCO2e':>12}  {'Primary':>8}  {'DQ':>5}  Tiers")
    for row in rows:
        tiers = " ".join(
            f"{t.value}:{v:,.0f}" for t, v in sorted(row.tier_breakdown.items())
        )
        print(
            f"{row.category.value:>4}  {row.total_tco2e:>12,.0f}  "
            f"{row.primary_share:>7.1%}  {row.weighted_dq_score:>5.2f}  {tiers}"
        )
    print(f"{'':>4}  {fx.TOTAL_SCOPE_3:>12,.0f}   total Scope 3")
    share = scope3_share(fx.SCOPE_1, fx.SCOPE_2, fx.TOTAL_SCOPE_3)
    print(
        f"\nScope 1 {fx.SCOPE_1:,.0f} · Scope 2 {fx.SCOPE_2:,.0f} · "
        f"Scope 3 is {share:.1%} of the footprint"
    )
    fuel_sold = sum(
        f.tco2e for f in fx.FIGURES if f.category is Category.C11_USE_OF_SOLD
    )
    print(
        f"Fuel sold alone is {fuel_sold / fx.TOTAL_SCOPE_3:.1%} of Scope 3, "
        "which is why criterion C22 bites."
    )

    # ------------------------------------------------------------------
    heading("2", "SBTi READINESS")
    for label, covered, fuel in (
        ("Proposed boundary (cat 1, 5, 11)", fx.COVERED, True),
        (
            "Without fuel sold",
            fx.COVERED - {Category.C11_USE_OF_SOLD},
            True,
        ),
    ):
        result = assess(
            fx.FIGURES,
            scope1=fx.SCOPE_1,
            scope2=fx.SCOPE_2,
            covered_categories=covered,
            sells_fossil_fuel=fuel,
        )
        verdict = "READY" if result.submission_ready else "BLOCKED"
        print(
            f"\n  {label}\n    coverage {result.near_term_coverage:.1%} "
            f"({result.rag.value.upper()})   exclusions {result.exclusion_share:.1%}   "
            f"{verdict}"
        )
        for blocker in result.blockers:
            print(f"    ! {blocker}")

    aligned = alignment_coverage(fx.FIGURES, fx.COUNTERPARTIES)
    print(
        f"\n  Supplier alignment: {aligned:.1%} of Scope 3 sits with counterparties "
        "holding validated targets."
    )
    gap = food_sector_2030_gap(fx.COUNTERPARTIES.values())
    noun = "supplier" if len(gap) == 1 else "suppliers"
    print(f"  Food-sector 2030 deadline: {len(gap)} {noun} without a validated target.")
    for counterparty in gap:
        print(f"    - {counterparty.name} ({counterparty.emissions_intensive_commodity})")

    # ------------------------------------------------------------------
    heading("3", "DATA QUALITY TRAJECTORY")
    t = trajectory(fx.FIGURES)
    print(f"  Primary data today      {t.current_primary_share:>7.1%}")
    print(f"  Primary data achievable {t.achievable_primary_share:>7.1%}")
    print(f"  Gain from the plan      {t.share_gain:>7.1%}")
    print(f"  Weighted DQ score       {t.current_dq_score:.2f} -> {t.achievable_dq_score:.2f}")
    print(f"  Tonnes of tier uplift   {t.uplift_tco2e:>7,.0f}")

    # ------------------------------------------------------------------
    heading("4", "ENGAGEMENT PLAN")
    uplift_by_counterparty: dict[str, float] = {}
    for figure in fx.FIGURES:
        if figure.counterparty_id:
            uplift_by_counterparty[figure.counterparty_id] = (
                uplift_by_counterparty.get(figure.counterparty_id, 0.0)
                + uplift_tonnes(figure)
            )

    scores = [
        score_counterparty(
            counterparty,
            uplift_tco2e=uplift_by_counterparty.get(cid, 0.0),
            annual_spend_gbp=fx.ANNUAL_SPEND.get(cid, 0.0),
            today=fx.TODAY,
        )
        for cid, counterparty in fx.COUNTERPARTIES.items()
    ]
    tiers = assign_tiers(scores)

    print(f"  {'Counterparty':<22} {'Tier':<5} {'Uplift':>9}  Route and reason")
    for s in sorted(scores, key=lambda x: (-x.score, -x.uplift_tco2e)):
        name = fx.COUNTERPARTIES[s.counterparty_id].name
        print(
            f"  {name:<22} {tiers[s.counterparty_id].value:<5} "
            f"{s.uplift_tco2e:>9,.0f}  {s.route.value}"
        )
        print(f"  {'':<22} {'':<5} {'':>9}  {s.reason}")

    engage = [s for s in scores if s.route is Route.ENGAGE_DIRECT and s.score > 0]
    print(
        f"\n  {len(engage)} counterparties to chase, carrying "
        f"{sum(s.uplift_tco2e for s in engage):,.0f} tCO2e of the "
        f"{t.uplift_tco2e:,.0f} available."
    )

    # ------------------------------------------------------------------
    heading("5", "NEXT ACTIONS")
    # The parent's CSRD consolidation date is what the wave is planned back from.
    deadline = date(2027, 1, 31)
    schedule = build_schedule(deadline)
    step = next_step(schedule, fx.TODAY)
    print(f"  Deadline {deadline:%d %b %Y}, evaluated {fx.TODAY:%d %b %Y}")
    if step:
        print(
            f"  Next step: {step.action}\n"
            f"    due {step.due:%d %b %Y}, {step.weeks_before} weeks out, "
            f"to the {step.rung.value.replace('_', ' ')}"
        )
    print("\n  Template per counterparty:")
    for cid in ("bidfood", "bakery", "beef_co"):
        counterparty = fx.COUNTERPARTIES[cid]
        template = template_for(counterparty, needs_product_footprints=True)
        cap = "" if counterparty.may_be_asked_beyond_vsme else "  (SME cap applies)"
        print(f"    {counterparty.name:<22} {template.value}{cap}")

    # ------------------------------------------------------------------
    heading("6", "EVIDENCE NEEDING REPLACEMENT")
    for lapse in lapsed(fx.DOCUMENTS, fx.TODAY):
        name = fx.COUNTERPARTIES[lapse.document.counterparty_id].name
        print(f"  [{lapse.status.value.upper():<7}] {name} · {lapse.document.doc_type.value}")
        print(f"            {lapse.reason}")

    # ------------------------------------------------------------------
    heading("7", "CONFLICTS RAISED")
    conflicts = collect(
        reported_vs_published(
            "Northern Beef Supply Scope 1",
            9_500,
            12_000,
            reported_source="questionnaire, 12 Aug 2026",
            published_source="2025 annual report, p41",
        ),
        overallocation("Bidfood", 130_000, 100_000),
        unevidenced_renewable_claim("Vale Dairies", True, False),
        certificate_scope_gap(
            "Northern Beef Supply", ["Carlisle"], ["Carlisle", "Preston"]
        ),
    )
    for c in conflicts:
        print(f"  {c.conflict_class.value} · {c.subject}")
        print(f"    {c.value_a} ({c.source_a})  vs  {c.value_b} ({c.source_b})")
        print(f"    proposed: {c.proposed_resolution}")
        print(f"    {c.rationale}")
    print(f"\n  {len(conflicts)} conflicts for human decision. None auto-applied.\n")


if __name__ == "__main__":
    main()
