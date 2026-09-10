"""Activity data times a factor. The arithmetic every other engine consumes.

A physical quantity in a known unit, a factor row, a figure. This is tier C in
the method hierarchy: the activity data may be primary, but the factor is an
average, so the result is average-data. Supplier-specific factors go through
:mod:`engines.partner` and reach tier A or B.

Reference: docs/product/nzc-ai-scope-3-brief.md section 3.3 and section 5.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

from .factors import FactorLibrary
from .types import Category, Figure, Tier

__all__ = ["ActivityLine", "calculate", "calculate_many", "format_quantity"]


def format_quantity(value: float) -> str:
    """Thousands separators, no exponent, no trailing noise on whole numbers."""
    if value == int(value):
        return f"{int(value):,}"
    return f"{value:,.2f}"


#: How a factor file's GHG category label maps onto the Category enum.
_CATEGORY_LABELS: dict[str, Category] = {
    f"Category {c.value}": c for c in Category
}


@dataclass(frozen=True)
class ActivityLine:
    """One measured or reported quantity awaiting a factor.

    `category` may be omitted, in which case the factor row's own category is
    used. Supplying it lets a caller override where a quantity lands, for
    instance a fuel purchase that is category 1 for a retailer buying for
    resale rather than the category 3 the well-to-tank row would suggest, and
    the override is recorded on the figure's method label.
    """

    factor_key: str
    quantity: float
    unit: str
    entity_id: Optional[str] = None
    counterparty_id: Optional[str] = None
    document_id: Optional[str] = None
    category: Optional[Category] = None
    achievable_tier: Optional[Tier] = None
    note: Optional[str] = None

    def __post_init__(self) -> None:
        if self.quantity < 0:
            raise ValueError(f"quantity must not be negative, got {self.quantity}")


def calculate(line: ActivityLine, library: FactorLibrary) -> Figure:
    """Turn one activity line into a figure with full lineage.

    Raises whatever the library raises: an unknown key, a unit that cannot be
    converted exactly, or a placeholder factor the library was not opened to
    admit. None of those is recoverable inside the engine, because each is a
    case where guessing would produce a wrong number that looks right.
    """
    factor = library.get(line.factor_key)
    tco2e = factor.tco2e_for(line.quantity, line.unit)

    if line.category is not None:
        category = line.category
        override = f"; placed in category {category.value} by the caller"
    else:
        try:
            category = _CATEGORY_LABELS[factor.ghg_category]
        except KeyError:
            raise ValueError(
                f"factor {factor.key!r} is {factor.ghg_category!r}, which is not a "
                "Scope 3 category; pass category= to place it, or use a Scope 1 "
                "or 2 engine"
            ) from None
        override = ""

    method = (
        f"{format_quantity(line.quantity)} {line.unit} x {factor.label} "
        f"({factor.basis}){override}"
    )
    if line.note:
        method += f"; {line.note}"

    return Figure(
        category=category,
        tco2e=tco2e,
        tier=Tier.C,
        factor_source=factor.source,
        factor_version=factor.version,
        counterparty_id=line.counterparty_id,
        document_id=line.document_id,
        achievable_tier=line.achievable_tier or Tier.C,
        entity_id=line.entity_id,
        activity_quantity=line.quantity,
        activity_unit=line.unit,
        factor_key=factor.key,
        factor_kgco2e=factor.kgco2e_per_unit,
        method_label=method,
    )


def calculate_many(
    lines: Iterable[ActivityLine], library: FactorLibrary
) -> list[Figure]:
    """Calculate a batch, failing on the first bad line rather than skipping it.

    A skipped line is a silently smaller inventory, which is the one outcome
    worse than a loud error.
    """
    return [calculate(line, library) for line in lines]
