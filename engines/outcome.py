"""What has actually worked: observed response rates by how we asked.

The chase engine starts with a fixed cadence and a guess at which channel
suits which counterparty. This engine replaces the guess with the record.
It reports observed rates by feature with a minimum sample, and orders options
by them. It does not fit a model, because the brief is clear that reporting
the evidence beats overclaiming, and because a consultancy's first year of
outcomes is a few hundred rows, not a training set.

Reference: docs/product/nzc-ai-scope-3-engagement-brief.md sections 8.4 and 14.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import date
from typing import Iterable, Literal, Optional, Sequence

from .types import ContactRung, RequestTemplate

__all__ = ["AttemptOutcome", "Rate", "rates_by", "recommend_order", "prefill_effect"]

Feature = Literal["channel", "rung", "prefilled", "template"]

#: Below this many attempts an option's rate is reported but not ranked on.
MIN_ATTEMPTS_TO_RANK = 5


@dataclass(frozen=True)
class AttemptOutcome:
    counterparty_id: str
    channel: str
    rung: ContactRung
    prefilled: bool
    template: RequestTemplate
    sent: date
    responded: bool
    hours_to_response: Optional[float] = None
    sector: Optional[str] = None


@dataclass(frozen=True)
class Rate:
    feature: str
    value: str
    attempts: int
    responses: int
    rate: float
    median_hours_to_response: Optional[float]

    @property
    def rankable(self) -> bool:
        return self.attempts >= MIN_ATTEMPTS_TO_RANK


def _value_of(outcome: AttemptOutcome, feature: Feature) -> str:
    if feature == "channel":
        return outcome.channel
    if feature == "rung":
        return outcome.rung.value
    if feature == "prefilled":
        return "prefilled" if outcome.prefilled else "blank"
    if feature == "template":
        return outcome.template.value
    raise ValueError(f"unknown feature {feature!r}")


def rates_by(
    outcomes: Iterable[AttemptOutcome],
    feature: Feature,
    *,
    sector: Optional[str] = None,
) -> list[Rate]:
    """Response rate per value of one feature, best first, ties by sample size."""
    buckets: dict[str, list[AttemptOutcome]] = {}
    for o in outcomes:
        if sector is not None and o.sector != sector:
            continue
        buckets.setdefault(_value_of(o, feature), []).append(o)

    rates: list[Rate] = []
    for value, group in buckets.items():
        responses = [o for o in group if o.responded]
        hours = [o.hours_to_response for o in responses if o.hours_to_response is not None]
        rates.append(
            Rate(
                feature=feature,
                value=value,
                attempts=len(group),
                responses=len(responses),
                rate=len(responses) / len(group),
                median_hours_to_response=statistics.median(hours) if hours else None,
            )
        )
    rates.sort(key=lambda r: (-r.rate, -r.attempts, r.value))
    return rates


def recommend_order(
    outcomes: Iterable[AttemptOutcome],
    feature: Feature,
    options: Sequence[str],
    *,
    sector: Optional[str] = None,
) -> list[str]:
    """Order `options` by observed rate where the sample allows, else as given.

    Under-sampled and unseen options keep the caller's order and follow the
    ranked ones, so a new channel is still tried, just not first.
    """
    observed = {r.value: r for r in rates_by(outcomes, feature, sector=sector)}
    ranked = [o for o in options if o in observed and observed[o].rankable]
    ranked.sort(key=lambda o: (-observed[o].rate, -observed[o].attempts))
    rest = [o for o in options if o not in ranked]
    return ranked + rest


def prefill_effect(outcomes: Iterable[AttemptOutcome]) -> Optional[float]:
    """Percentage-point lift in response rate from pre-filling, if measurable.

    None until both arms have enough attempts to say anything. This is the
    single number that justifies the enrichment pipeline, so it is worth
    computing honestly rather than asserting.
    """
    rates = {r.value: r for r in rates_by(outcomes, "prefilled")}
    pre = rates.get("prefilled")
    blank = rates.get("blank")
    if pre is None or blank is None or not (pre.rankable and blank.rankable):
        return None
    return pre.rate - blank.rate
