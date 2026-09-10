"""Data quality: method tiers, the ESRS primary/secondary split, and trajectory.

ESRS E1-6 requires the proportion of each Scope 3 category that rests on
primary data against secondary estimates. SBTi requires a data improvement
plan. Both fall out of the same arithmetic, so long as every figure carries
the tier it was computed at and the tier it could reach.

Reference: docs/product/nzc-ai-scope-3-brief.md section 3.3,
           docs/product/nzc-ai-scope-3-engagement-brief.md section 9.1.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable, Sequence

from .types import DQ_SCORE, Category, Figure, Tier, is_primary

__all__ = [
    "CategoryQuality",
    "Trajectory",
    "primary_share",
    "weighted_dq_score",
    "category_breakdown",
    "trajectory",
    "uplift_tonnes",
]


@dataclass(frozen=True)
class CategoryQuality:
    """The ESRS E1-6 disclosure row for one category."""

    category: Category
    total_tco2e: float
    primary_tco2e: float
    secondary_tco2e: float
    primary_share: float
    weighted_dq_score: float
    tier_breakdown: dict[Tier, float]


@dataclass(frozen=True)
class Trajectory:
    """Where the inventory's data quality is, and where the plan would take it."""

    current_primary_share: float
    achievable_primary_share: float
    current_dq_score: float
    achievable_dq_score: float
    uplift_tco2e: float

    @property
    def share_gain(self) -> float:
        """Percentage points of primary share the plan would add."""
        return self.achievable_primary_share - self.current_primary_share


def _total(figures: Iterable[Figure]) -> float:
    return sum(f.tco2e for f in figures)


def primary_share(figures: Sequence[Figure]) -> float:
    """Share of emissions resting on supplier-specific or hybrid data.

    Returns 0.0 for an empty inventory rather than raising: a client with no
    figures yet has no primary data, which is the honest answer and keeps the
    dashboard rendering on day one.
    """
    total = _total(figures)
    if total == 0:
        return 0.0
    primary = sum(f.tco2e for f in figures if is_primary(f.tier))
    return primary / total


def weighted_dq_score(figures: Sequence[Figure], *, achievable: bool = False) -> float:
    """Emissions-weighted average data-quality score, 1 best to 5 worst.

    Weighting by tonnes rather than by row count is deliberate. Ten thousand
    well-evidenced stationery lines should not flatter an inventory whose beef
    supply is a spend-based guess.
    """
    total = _total(figures)
    if total == 0:
        return 0.0
    weighted = 0.0
    for f in figures:
        tier = (f.achievable_tier or f.tier) if achievable else f.tier
        weighted += f.tco2e * DQ_SCORE[tier]
    return weighted / total


def category_breakdown(figures: Sequence[Figure]) -> list[CategoryQuality]:
    """One ESRS E1-6 row per category present, ordered by category number."""
    by_category: dict[Category, list[Figure]] = defaultdict(list)
    for f in figures:
        by_category[f.category].append(f)

    rows: list[CategoryQuality] = []
    for category in sorted(by_category, key=lambda c: int(c.value)):
        group = by_category[category]
        total = _total(group)
        primary = sum(f.tco2e for f in group if is_primary(f.tier))
        tiers: dict[Tier, float] = defaultdict(float)
        for f in group:
            tiers[f.tier] += f.tco2e
        rows.append(
            CategoryQuality(
                category=category,
                total_tco2e=total,
                primary_tco2e=primary,
                secondary_tco2e=total - primary,
                primary_share=(primary / total) if total else 0.0,
                weighted_dq_score=weighted_dq_score(group),
                tier_breakdown=dict(tiers),
            )
        )
    return rows


def uplift_tonnes(figure: Figure) -> float:
    """Tonnes of improvement available on one figure, scaled by the tier gap.

    A figure already at its achievable tier yields nothing. One sitting at
    spend-based that a supplier response would move to supplier-specific yields
    close to its full weight. The denominator is the widest possible gap, tier
    E to tier A, so the result is a fraction of the emissions rather than an
    arbitrary index.
    """
    achievable = figure.achievable_tier or figure.tier
    gap = DQ_SCORE[figure.tier] - DQ_SCORE[achievable]
    if gap <= 0:
        return 0.0
    widest_gap = DQ_SCORE[Tier.E] - DQ_SCORE[Tier.A]
    return figure.tco2e * gap / widest_gap


def trajectory(figures: Sequence[Figure]) -> Trajectory:
    """Current data quality against what the engagement plan would achieve."""
    total = _total(figures)
    if total == 0:
        return Trajectory(0.0, 0.0, 0.0, 0.0, 0.0)

    achievable_primary = sum(
        f.tco2e for f in figures if is_primary(f.achievable_tier or f.tier)
    )
    return Trajectory(
        current_primary_share=primary_share(figures),
        achievable_primary_share=achievable_primary / total,
        current_dq_score=weighted_dq_score(figures),
        achievable_dq_score=weighted_dq_score(figures, achievable=True),
        uplift_tco2e=sum(uplift_tonnes(f) for f in figures),
    )
