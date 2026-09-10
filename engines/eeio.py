"""Spend-based emissions: money times an input-output factor.

The method of last resort, and for most of category 1 the method of first
resort until suppliers respond. Tier D. Everything here is designed to be
replaced: the whole point of the engagement layer is to move tonnes off this
engine and onto :mod:`engines.partner`.

Two adjustments matter and both are explicit. Spend is deflated to the
factor's price year, because a 2024 factor applied to 2026 money overstates
emissions by the inflation in between. And spend that carries no emissions
of its own, such as VAT, is excluded before the factor is applied.

Reference: docs/product/nzc-ai-scope-3-brief.md section 3.3 tier D.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping, Optional

from .factors import FactorLibrary
from .types import Category, Figure, Tier

__all__ = ["SpendLine", "PriceIndex", "calculate", "calculate_many"]


@dataclass(frozen=True)
class SpendLine:
    """One purchase-ledger amount, already mapped to a sector."""

    sector_key: str
    amount_gbp: float
    spend_year: int
    entity_id: Optional[str] = None
    counterparty_id: Optional[str] = None
    document_id: Optional[str] = None
    category: Optional[Category] = None
    #: What a supplier response could raise this to. Defaults to A on the
    #: assumption that a supplier-specific figure is obtainable; the scoring
    #: engine decides whether it is worth chasing.
    achievable_tier: Tier = Tier.A
    vat_included: bool = False

    def __post_init__(self) -> None:
        if self.amount_gbp < 0:
            raise ValueError(f"spend must not be negative, got {self.amount_gbp}")


#: Standard UK VAT rate, for stripping it where a ledger line is gross.
VAT_RATE = 0.20


@dataclass(frozen=True)
class PriceIndex:
    """Year-to-index values for deflating spend to a factor's price year.

    Any consistent index will do (CPI, a sector deflator); what matters is that
    the same one is used for the spend year and the factor year, and that its
    source is recorded on the resulting method label.
    """

    source: str
    values: Mapping[int, float]

    def deflate(self, amount: float, from_year: int, to_year: int) -> float:
        if from_year == to_year:
            return amount
        try:
            return amount * self.values[to_year] / self.values[from_year]
        except KeyError as missing:
            raise ValueError(
                f"price index {self.source!r} has no value for year {missing}"
            ) from None


_CATEGORY_LABELS: dict[str, Category] = {f"Category {c.value}": c for c in Category}


def calculate(
    line: SpendLine,
    library: FactorLibrary,
    *,
    price_index: Optional[PriceIndex] = None,
) -> Figure:
    """Spend times sector factor, deflated, with VAT stripped if present.

    Without a price index the spend year must equal the factor year, and a
    mismatch is refused rather than silently applied at the wrong price level.
    """
    factor = library.get(line.sector_key)
    if factor.unit != "gbp":
        raise ValueError(
            f"factor {factor.key!r} is per {factor.unit!r}, not per gbp; use the "
            "activity engine for physical quantities"
        )

    net = line.amount_gbp
    steps: list[str] = []
    if line.vat_included:
        net = net / (1 + VAT_RATE)
        steps.append(f"VAT at {VAT_RATE:.0%} removed")

    factor_year = int(factor.version)
    if line.spend_year != factor_year:
        if price_index is None:
            raise ValueError(
                f"spend year {line.spend_year} differs from factor year "
                f"{factor_year} and no price index was supplied to deflate it"
            )
        net = price_index.deflate(net, line.spend_year, factor_year)
        steps.append(
            f"deflated {line.spend_year} to {factor_year} prices via {price_index.source}"
        )

    tco2e = net * factor.kgco2e_per_unit / 1000.0
    category = line.category or _CATEGORY_LABELS[factor.ghg_category]

    method = f"£{line.amount_gbp:,.2f} x {factor.label}"
    if steps:
        method += "; " + "; ".join(steps)

    return Figure(
        category=category,
        tco2e=tco2e,
        tier=Tier.D,
        factor_source=factor.source,
        factor_version=factor.version,
        counterparty_id=line.counterparty_id,
        document_id=line.document_id,
        achievable_tier=line.achievable_tier,
        entity_id=line.entity_id,
        activity_quantity=net,
        activity_unit="gbp",
        factor_key=factor.key,
        factor_kgco2e=factor.kgco2e_per_unit,
        method_label=method,
    )


def calculate_many(
    lines: Iterable[SpendLine],
    library: FactorLibrary,
    *,
    price_index: Optional[PriceIndex] = None,
) -> list[Figure]:
    return [calculate(line, library, price_index=price_index) for line in lines]
