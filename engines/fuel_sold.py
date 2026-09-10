"""Category 11 for fuel retailers, and the treatment of resold electricity.

For a forecourt operator this is usually the largest single line in the
inventory, and SBTi criterion C22 requires a separate 1.5C-aligned target for
it whatever its share of the total. Litres sold times the combustion factor.

The upstream part of the same fuel, extraction and refining and transport to
the forecourt, is a different question: it is category 1 for a retailer who
buys fuel for resale, and outside the boundary for one who operates the
forecourt under a licence from the fuel company. That is decided by
:mod:`engines.boundary`; this engine takes the answer as a flag.

Reference: docs/product/nzc-ai-scope-3-brief.md section 3.4.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

from .factors import FactorLibrary
from .types import Category, Figure, Tier

__all__ = ["FuelSale", "ElectricitySale", "calculate", "calculate_many", "electricity_sold"]


@dataclass(frozen=True)
class FuelSale:
    """Litres of one fuel sold over a period at one site."""

    combustion_factor_key: str
    litres: float
    entity_id: Optional[str] = None
    document_id: Optional[str] = None
    #: The well-to-tank row for the same fuel, applied only where we buy the
    #: fuel for resale. None means no upstream line is produced.
    wtt_factor_key: Optional[str] = None
    buys_for_resale: bool = False

    def __post_init__(self) -> None:
        if self.litres < 0:
            raise ValueError(f"litres must not be negative, got {self.litres}")


@dataclass(frozen=True)
class ElectricitySale:
    """kWh sold to drivers at owned chargers over a period."""

    kwh: float
    entity_id: Optional[str] = None
    pass_through_elected: bool = False


def calculate(sale: FuelSale, library: FactorLibrary) -> list[Figure]:
    """One or two figures: category 11 always, category 1 if we bought for resale.

    Fuel sold is activity data times an average factor, so tier C, and there
    is no better tier to reach: the customer combusts it and nobody will
    supply a specific factor for that.
    """
    combustion = library.get(sale.combustion_factor_key)
    figures = [
        Figure(
            category=Category.C11_USE_OF_SOLD,
            tco2e=combustion.tco2e_for(sale.litres, "litre"),
            tier=Tier.C,
            factor_source=combustion.source,
            factor_version=combustion.version,
            document_id=sale.document_id,
            achievable_tier=Tier.C,
            entity_id=sale.entity_id,
            activity_quantity=sale.litres,
            activity_unit="litre",
            factor_key=combustion.key,
            factor_kgco2e=combustion.kgco2e_per_unit,
            method_label=(
                f"{sale.litres:,.0f} litres sold x {combustion.label}; combustion "
                "by the customer. SBTi C22: separate target required."
            ),
        )
    ]

    if sale.buys_for_resale:
        if sale.wtt_factor_key is None:
            raise ValueError(
                "fuel bought for resale needs a well-to-tank factor key for the "
                "category 1 line; none supplied"
            )
        wtt = library.get(sale.wtt_factor_key)
        figures.append(
            Figure(
                category=Category.C1_PURCHASED_GOODS,
                tco2e=wtt.tco2e_for(sale.litres, "litre"),
                tier=Tier.C,
                factor_source=wtt.source,
                factor_version=wtt.version,
                document_id=sale.document_id,
                achievable_tier=Tier.B,
                entity_id=sale.entity_id,
                activity_quantity=sale.litres,
                activity_unit="litre",
                factor_key=wtt.key,
                factor_kgco2e=wtt.kgco2e_per_unit,
                method_label=(
                    f"{sale.litres:,.0f} litres bought for resale x {wtt.label}; "
                    "extraction, refining and delivery in category 1. A supplier "
                    "well-to-tank figure would raise this to tier B."
                ),
            )
        )

    return figures


def calculate_many(sales: Iterable[FuelSale], library: FactorLibrary) -> list[Figure]:
    figures: list[Figure] = []
    for sale in sales:
        figures.extend(calculate(sale, library))
    return figures


def electricity_sold(sale: ElectricitySale) -> tuple[Optional[Figure], str]:
    """Resold charging electricity produces no figure. It produces a disclosure.

    The electricity is already in Scope 2 as purchased electricity, so raising
    a second line double counts. What must be recorded is the kWh sold and the
    basis on which it is reported, for the methodology note.
    """
    if sale.pass_through_elected:
        return (
            None,
            f"{sale.kwh:,.0f} kWh sold to drivers under a documented pass-through "
            "election; excluded from Scope 2 on that basis. The election document "
            "is the evidence.",
        )
    return (
        None,
        f"{sale.kwh:,.0f} kWh sold to drivers, reported gross within Scope 2 as "
        "purchased electricity. Not raised as a separate line, to avoid double "
        "counting.",
    )
