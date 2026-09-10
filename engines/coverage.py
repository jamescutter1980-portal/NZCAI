"""SBTi and ESRS coverage tests.

These are pass or fail gates a submission turns on, so the thresholds are
named constants with their source in the docstring rather than magic numbers
buried in a comparison.

Sources:
    SBTi Corporate Near-Term Criteria V5.3.1, criteria C4, C6, C9 and C22.
    SBTi Corporate Net-Zero Standard V2 (long-term coverage, supplier and
    customer alignment target types, food-sector supplier requirement).
    ESRS E1-6 (gross Scope 3 by category with the primary/secondary split).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Iterable, Sequence

from .types import Category, Counterparty, Figure

__all__ = [
    "RAG",
    "CoverageResult",
    "EMISSIONS_INTENSIVE_COMMODITIES",
    "NEAR_TERM_COVERAGE_MINIMUM",
    "LONG_TERM_COVERAGE_MINIMUM",
    "EXCLUSION_MAXIMUM",
    "SCOPE_3_MATERIALITY_THRESHOLD",
    "scope3_share",
    "scope3_target_required",
    "coverage_rag",
    "assess",
    "alignment_coverage",
    "food_sector_2030_gap",
]


#: C6. Near-term Scope 3 targets must collectively cover at least this share of
#: total Scope 3 emissions.
NEAR_TERM_COVERAGE_MINIMUM = 0.67

#: Net-Zero Standard. Long-term targets must cover at least this share.
LONG_TERM_COVERAGE_MINIMUM = 0.90

#: C9. Excluded categories must sum to less than this share of total Scope 3,
#: each exclusion carrying quantitative evidence rather than an assertion that
#: the data was hard to get.
EXCLUSION_MAXIMUM = 0.05

#: C4. Where Scope 3 is at least this share of total Scope 1, 2 and 3, it must
#: be included in near-term targets.
SCOPE_3_MATERIALITY_THRESHOLD = 0.40

#: Comfortably above the minimum, so a submission is not one restatement away
#: from failing.
COVERAGE_COMFORT_THRESHOLD = 0.75

#: Net-Zero Standard V2, food sector. Suppliers of these commodities must hold
#: validated science-based net-zero targets by 2030.
EMISSIONS_INTENSIVE_COMMODITIES: frozenset[str] = frozenset(
    {"livestock", "dairy", "soy", "palm_oil", "grains"}
)

FOOD_SECTOR_SUPPLIER_DEADLINE_YEAR = 2030


class RAG(str, Enum):
    GREEN = "green"
    AMBER = "amber"
    RED = "red"


@dataclass(frozen=True)
class CoverageResult:
    """The full readiness picture, with the reasons a submission would fail."""

    scope3_share: float
    scope3_target_required: bool
    near_term_coverage: float
    near_term_pass: bool
    long_term_coverage: float
    long_term_pass: bool
    exclusion_share: float
    exclusion_pass: bool
    category_11_mandatory: bool
    category_11_covered: bool
    rag: RAG
    blockers: tuple[str, ...]

    @property
    def submission_ready(self) -> bool:
        return not self.blockers


def scope3_share(scope1: float, scope2: float, scope3: float) -> float:
    """Scope 3 as a share of the whole footprint. Zero footprint returns 0.0."""
    total = scope1 + scope2 + scope3
    if total <= 0:
        return 0.0
    return scope3 / total


def scope3_target_required(scope1: float, scope2: float, scope3: float) -> bool:
    """C4: whether Scope 3 must be inside the near-term target boundary."""
    return scope3_share(scope1, scope2, scope3) >= SCOPE_3_MATERIALITY_THRESHOLD


def coverage_rag(coverage: float) -> RAG:
    """Traffic light on near-term coverage against the C6 minimum."""
    if coverage >= COVERAGE_COMFORT_THRESHOLD:
        return RAG.GREEN
    if coverage >= NEAR_TERM_COVERAGE_MINIMUM:
        return RAG.AMBER
    return RAG.RED


def _tonnes(figures: Iterable[Figure]) -> float:
    return sum(f.tco2e for f in figures)


def assess(
    figures: Sequence[Figure],
    *,
    scope1: float,
    scope2: float,
    covered_categories: frozenset[Category],
    excluded_categories: frozenset[Category] = frozenset(),
    sells_fossil_fuel: bool = False,
) -> CoverageResult:
    """Run every SBTi gate over an inventory and say what would block it.

    Args:
        figures: the Scope 3 inventory.
        scope1, scope2: operational emissions, needed for the C4 share test.
        covered_categories: categories inside the proposed target boundary.
        excluded_categories: categories excluded from the inventory, each of
            which needs a quantified estimate and a documented reason.
        sells_fossil_fuel: whether the organisation sells, transmits or
            distributes fossil fuels, which triggers C22 regardless of share.

    Returns:
        A CoverageResult. `blockers` is empty only where every gate passes.
    """
    total_s3 = _tonnes(figures)
    covered = _tonnes(f for f in figures if f.category in covered_categories)
    excluded = _tonnes(f for f in figures if f.category in excluded_categories)

    near_term = (covered / total_s3) if total_s3 else 0.0
    exclusion = (excluded / total_s3) if total_s3 else 0.0

    cat_11_mandatory = sells_fossil_fuel
    cat_11_covered = Category.C11_USE_OF_SOLD in covered_categories

    blockers: list[str] = []
    if near_term < NEAR_TERM_COVERAGE_MINIMUM:
        # Kept in size order, heaviest first, because the message claims to
        # name the largest. Re-sorting numerically here would make the order
        # look like category numbering and mislead the reader about weight.
        missing = ", ".join(
            c.value for c in _largest_uncovered(figures, covered_categories)
        )
        blockers.append(
            f"Near-term coverage is {near_term:.1%}, below the {NEAR_TERM_COVERAGE_MINIMUM:.0%} "
            f"minimum. Largest uncovered categories: {missing}."
        )
    if exclusion >= EXCLUSION_MAXIMUM:
        blockers.append(
            f"Exclusions are {exclusion:.1%} of Scope 3, at or above the "
            f"{EXCLUSION_MAXIMUM:.0%} cap."
        )
    if cat_11_mandatory and not cat_11_covered:
        blockers.append(
            "Category 11 is mandatory under criterion C22 because the "
            "organisation sells fossil fuels, and it is not in the target "
            "boundary."
        )

    return CoverageResult(
        scope3_share=scope3_share(scope1, scope2, total_s3),
        scope3_target_required=scope3_target_required(scope1, scope2, total_s3),
        near_term_coverage=near_term,
        near_term_pass=near_term >= NEAR_TERM_COVERAGE_MINIMUM,
        long_term_coverage=near_term,
        long_term_pass=near_term >= LONG_TERM_COVERAGE_MINIMUM,
        exclusion_share=exclusion,
        exclusion_pass=exclusion < EXCLUSION_MAXIMUM,
        category_11_mandatory=cat_11_mandatory,
        category_11_covered=cat_11_covered,
        rag=coverage_rag(near_term),
        blockers=tuple(blockers),
    )


def _largest_uncovered(
    figures: Sequence[Figure], covered: frozenset[Category]
) -> list[Category]:
    """Uncovered categories, heaviest first, so the message names what to add."""
    weights: dict[Category, float] = {}
    for f in figures:
        if f.category not in covered:
            weights[f.category] = weights.get(f.category, 0.0) + f.tco2e
    return sorted(weights, key=lambda c: weights[c], reverse=True)[:3]


def alignment_coverage(
    figures: Sequence[Figure], counterparties: dict[str, Counterparty]
) -> float:
    """Share of Scope 3 attributable to counterparties holding validated targets.

    Under the Net-Zero Standard V2 this is a target type in its own right, so
    it needs to be measured rather than asserted. Figures with no counterparty
    attached count against the denominator: unattributed emissions are not
    aligned emissions.
    """
    total = _tonnes(figures)
    if total == 0:
        return 0.0
    aligned = 0.0
    for f in figures:
        if f.counterparty_id is None:
            continue
        counterparty = counterparties.get(f.counterparty_id)
        if counterparty is not None and counterparty.has_validated_target:
            aligned += f.tco2e
    return aligned / total


def food_sector_2030_gap(
    counterparties: Iterable[Counterparty],
) -> list[Counterparty]:
    """Emissions-intensive commodity suppliers without a validated target.

    The Net-Zero Standard V2 requires food-sector companies to ensure these
    suppliers hold validated science-based net-zero targets by 2030. For a
    caterer this is a named worklist with a deadline, not an abstraction.
    Returned in name order so the list is stable between runs.
    """
    gap = [
        c
        for c in counterparties
        if c.emissions_intensive_commodity in EMISSIONS_INTENSIVE_COMMODITIES
        and not c.has_validated_target
    ]
    return sorted(gap, key=lambda c: c.name)
