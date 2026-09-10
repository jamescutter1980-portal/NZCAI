"""Engagement scoring: who to chase, in what order, and who not to chase at all.

Chasing four hundred suppliers with equal effort is how these programmes fail.
The score turns "engage the supply chain" into a ranked worklist with the
tonnes at stake against each line, and it is honest about the counterparties
where the leverage runs the wrong way: a franchisee cannot compel its
franchisor to disclose, so queuing a request there wastes the quarter.

Reference: docs/product/nzc-ai-scope-3-engagement-brief.md section 9.2.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from enum import Enum
from typing import Optional, Sequence

from .types import Counterparty

__all__ = [
    "Route",
    "EngagementTier",
    "Score",
    "winnability",
    "leverage",
    "score_counterparty",
    "assign_tiers",
]


class Route(str, Enum):
    """What the plan should actually do about this counterparty."""

    ENGAGE_DIRECT = "engage_direct"
    ACCEPT_PUBLISHED = "accept_published"
    NEGOTIATE_AT_RENEWAL = "negotiate_at_renewal"
    USE_SECONDARY = "use_secondary"


class EngagementTier(str, Enum):
    """How much effort this counterparty gets this period."""

    T1_PRIMARY = "T1"
    T2_TARGETED = "T2"
    T3_PUBLIC_ONLY = "T3"
    T4_SECONDARY = "T4"


@dataclass(frozen=True)
class Score:
    counterparty_id: str
    uplift_tco2e: float
    winnability: float
    leverage: float
    score: float
    route: Route
    reason: str


#: Observable features and their weight in the likelihood of a useful reply.
#: These are starting weights to be replaced by observed response rates once
#: enough attempts have been recorded; the outcome table exists for that.
_WINNABILITY_WEIGHTS: dict[str, float] = {
    "has_public_report": 0.25,
    "is_cdp_responder": 0.20,
    "has_validated_target": 0.15,
    "has_named_contact": 0.20,
    "responded_before": 0.30,
}

#: Floor and ceiling. Nobody is certain to answer and nobody is hopeless, and
#: a zero would collapse the whole score to zero on one missing feature.
_WINNABILITY_FLOOR = 0.05
_WINNABILITY_CEILING = 0.95

#: A small supplier is likelier to lack the capability to answer at all, quite
#: apart from being entitled to decline anything beyond the voluntary standard.
_SME_PENALTY = 0.15

#: Spend at or above this share of a counterparty's turnover is treated as
#: maximum commercial leverage.
_LEVERAGE_SPEND_CAP = 0.10

#: A renewal inside this window is a live negotiating moment.
_RENEWAL_WINDOW_DAYS = 365


def winnability(counterparty: Counterparty) -> float:
    """Likelihood of a useful response, between the floor and the ceiling."""
    raw = 0.0
    for attribute, weight in _WINNABILITY_WEIGHTS.items():
        if getattr(counterparty, attribute):
            raw += weight

    if (
        counterparty.employee_band is not None
        and not counterparty.may_be_asked_beyond_vsme
    ):
        raw -= _SME_PENALTY

    return max(_WINNABILITY_FLOOR, min(_WINNABILITY_CEILING, raw))


def leverage(
    counterparty: Counterparty,
    *,
    annual_spend_gbp: float,
    today: date,
) -> float:
    """How much influence we have, from -1.0 to 1.0.

    Negative means the counterparty holds power over us. A franchisor sets the
    terms a franchisee operates under, so a data request from the franchisee is
    a favour asked, not an instruction given, and the plan should say so
    instead of scheduling six chasers.
    """
    if counterparty.is_dominant:
        return -1.0

    value = 0.0

    if counterparty.turnover_gbp:
        share = annual_spend_gbp / counterparty.turnover_gbp
        value += min(share / _LEVERAGE_SPEND_CAP, 1.0) * 0.6

    if counterparty.contractual_data_right:
        value += 0.3

    if counterparty.contract_end is not None:
        days = (counterparty.contract_end - today).days
        if 0 <= days <= _RENEWAL_WINDOW_DAYS:
            value += 0.1 * (1 - days / _RENEWAL_WINDOW_DAYS)

    return max(0.0, min(1.0, value))


def score_counterparty(
    counterparty: Counterparty,
    *,
    uplift_tco2e: float,
    annual_spend_gbp: float,
    today: date,
) -> Score:
    """Rank one counterparty and say what to do about it.

    Args:
        uplift_tco2e: tonnes that would improve tier if they responded, from
            :func:`engines.quality.uplift_tonnes` summed over their figures.
        annual_spend_gbp: what we spend with them, for the leverage term.
        today: evaluation date, for contract renewal proximity.
    """
    win = winnability(counterparty)
    lev = leverage(counterparty, annual_spend_gbp=annual_spend_gbp, today=today)

    if lev < 0:
        route, reason = _dominant_route(counterparty)
        return Score(counterparty.id, uplift_tco2e, win, lev, 0.0, route, reason)

    value = uplift_tco2e * win * lev

    if uplift_tco2e <= 0:
        return Score(
            counterparty.id,
            uplift_tco2e,
            win,
            lev,
            0.0,
            Route.USE_SECONDARY,
            "Already at its achievable tier, so a request would change nothing.",
        )

    return Score(
        counterparty.id,
        uplift_tco2e,
        win,
        lev,
        value,
        Route.ENGAGE_DIRECT,
        f"{uplift_tco2e:,.0f} tCO2e of tier improvement available, "
        f"winnability {win:.0%}, leverage {lev:.0%}.",
    )


def _dominant_route(counterparty: Counterparty) -> tuple[Route, str]:
    """What to do where the counterparty holds the power."""
    if counterparty.has_public_report:
        return (
            Route.ACCEPT_PUBLISHED,
            "They set our terms, not the reverse, but they publish. Take the "
            "published figure as evidence rather than queuing a request.",
        )
    if counterparty.contract_end is not None:
        return (
            Route.NEGOTIATE_AT_RENEWAL,
            "They set our terms and publish nothing. The realistic route is a "
            "data clause at contract renewal.",
        )
    return (
        Route.NEGOTIATE_AT_RENEWAL,
        "They set our terms and publish nothing, with no renewal date on "
        "record. Establish the renewal date before spending effort here.",
    )


#: Share of total available uplift that the top tier of counterparties covers.
_T1_UPLIFT_SHARE = 0.50
#: Cumulative share by the end of the second tier.
_T2_UPLIFT_SHARE = 0.80


def assign_tiers(scores: Sequence[Score]) -> dict[str, EngagementTier]:
    """Split a scored population into effort tiers by cumulative uplift.

    Deliberately Pareto rather than threshold-based. Absolute score thresholds
    do not travel between a caterer and a logistics operator, but "the
    counterparties carrying the first half of the available improvement" does.

    Counterparties routed to published data take T3 and are never chased;
    those with nothing to gain take T4 and stay on secondary factors.
    """
    tiers: dict[str, EngagementTier] = {}
    chaseable: list[Score] = []

    for s in scores:
        if s.route is Route.ACCEPT_PUBLISHED:
            tiers[s.counterparty_id] = EngagementTier.T3_PUBLIC_ONLY
        elif s.route is Route.USE_SECONDARY:
            tiers[s.counterparty_id] = EngagementTier.T4_SECONDARY
        elif s.route is Route.NEGOTIATE_AT_RENEWAL:
            tiers[s.counterparty_id] = EngagementTier.T2_TARGETED
        else:
            chaseable.append(s)

    total = sum(s.score for s in chaseable)
    if total <= 0:
        for s in chaseable:
            tiers[s.counterparty_id] = EngagementTier.T4_SECONDARY
        return tiers

    running = 0.0
    for s in sorted(chaseable, key=lambda x: x.score, reverse=True):
        # Band on the share already accounted for *before* this counterparty,
        # so the largest contributor always lands in T1 even where it alone
        # carries more than the whole first band.
        share_before = running / total
        if share_before < _T1_UPLIFT_SHARE:
            tiers[s.counterparty_id] = EngagementTier.T1_PRIMARY
        elif share_before < _T2_UPLIFT_SHARE:
            tiers[s.counterparty_id] = EngagementTier.T2_TARGETED
        else:
            tiers[s.counterparty_id] = EngagementTier.T4_SECONDARY
        running += s.score
    return tiers
