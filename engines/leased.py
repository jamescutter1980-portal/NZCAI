"""Categories 13, 8 and 14 from outlet energy, placed by the boundary rules.

The site ledger holds kWh per outlet. Which category that energy lands in,
if any, is decided by :func:`engines.boundary.classify` from the outlet's
operator role and the perspective being reported. This engine applies that
decision and the factor, and it carries the shared-site allocation with it,
because a per-outlet figure is only as good as the method that split the
common areas between outlets.

Reference: docs/product/nzc-ai-scope-3-brief.md sections 3.1 and 3.2.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

from .boundary import Placement, classify
from .factors import FactorLibrary
from .types import ActivityKind, Category, Classification, Figure, OperatorRole, Perspective, Tier

__all__ = ["OutletEnergy", "Placed", "calculate", "calculate_many"]


#: Which Scope 3 category each in-boundary classification maps to. Scope 1 and
#: 2 placements produce no Scope 3 figure and are reported as such.
_SCOPE3_OF: dict[Classification, Category] = {
    Classification.CAT_13: Category.C13_DOWNSTREAM_LEASED,
    Classification.CAT_14: Category.C14_FRANCHISES,
}


@dataclass(frozen=True)
class OutletEnergy:
    """One outlet's energy over a period, with how any shared energy was split."""

    outlet_id: str
    entity_id: str
    role: OperatorRole
    fuel_kwh: float
    electricity_kwh: float
    period: int
    #: Fraction of the site's shared energy attributed to this outlet, and
    #: the method used. Required for franchisor packs and category 13.
    allocation_share: float = 1.0
    allocation_method: str = "sub-metered"
    #: We operate the outlet but the landlord holds the supply and recharges
    #: us. That is our category 8, not our Scope 1 and 2.
    energy_bought_by_landlord: bool = False
    document_id: Optional[str] = None
    space_leased: bool = True

    def __post_init__(self) -> None:
        if not 0.0 <= self.allocation_share <= 1.0:
            raise ValueError("allocation_share must be a fraction")
        if self.fuel_kwh < 0 or self.electricity_kwh < 0:
            raise ValueError("energy must not be negative")


@dataclass(frozen=True)
class Placed:
    """Where one outlet's energy went, and the figures if any.

    When the placement is Scope 1 or 2, `figures` is empty and `note` says so:
    that energy belongs in the operational inventory, not here.
    """

    outlet_id: str
    fuel: Placement
    electricity: Placement
    figures: tuple[Figure, ...]
    note: str


def calculate(
    outlet: OutletEnergy,
    library: FactorLibrary,
    *,
    perspective: Perspective = Perspective.OPERATOR,
    electricity_factor_key: str = "electricity_uk_grid",
    fuel_factor_key: str = "natural_gas",
) -> Placed:
    """Place and calculate one outlet's energy for the Scope 3 inventory."""
    fuel_place = classify(
        outlet.role, ActivityKind.ENERGY_FUEL, perspective, space_leased=outlet.space_leased
    )
    elec_place = classify(
        outlet.role,
        ActivityKind.ENERGY_ELECTRICITY,
        perspective,
        space_leased=outlet.space_leased,
    )

    figures: list[Figure] = []
    notes: list[str] = []

    for kwh, place, key, label in (
        (outlet.fuel_kwh, fuel_place, fuel_factor_key, "fuel"),
        (outlet.electricity_kwh, elec_place, electricity_factor_key, "electricity"),
    ):
        if kwh == 0:
            continue

        if place.classification in (Classification.SCOPE_1, Classification.SCOPE_2):
            if outlet.energy_bought_by_landlord:
                category = Category.C8_UPSTREAM_LEASED
                reason = "landlord holds the supply and recharges us"
            else:
                notes.append(
                    f"{label}: {place.classification.value}, belongs in the "
                    "operational inventory"
                )
                continue
        elif place.classification in _SCOPE3_OF:
            category = _SCOPE3_OF[place.classification]
            reason = place.note
        else:
            notes.append(f"{label}: {place.note}")
            continue

        factor = library.get(key)
        allocated = kwh * outlet.allocation_share
        figures.append(
            Figure(
                category=category,
                tco2e=factor.tco2e_for(allocated, "kWh"),
                tier=Tier.C,
                factor_source=factor.source,
                factor_version=factor.version,
                document_id=outlet.document_id,
                achievable_tier=Tier.A,
                entity_id=outlet.entity_id,
                activity_quantity=allocated,
                activity_unit="kWh",
                factor_key=factor.key,
                factor_kgco2e=factor.kgco2e_per_unit,
                method_label=(
                    f"Outlet {outlet.outlet_id} {label}: {kwh:,.0f} kWh x "
                    f"{outlet.allocation_share:.0%} ({outlet.allocation_method}) x "
                    f"{factor.label}. {reason}"
                ),
            )
        )

    if not notes:
        notes.append("all energy placed in Scope 3")
    return Placed(
        outlet_id=outlet.outlet_id,
        fuel=fuel_place,
        electricity=elec_place,
        figures=tuple(figures),
        note="; ".join(notes),
    )


def calculate_many(
    outlets: Iterable[OutletEnergy],
    library: FactorLibrary,
    *,
    perspective: Perspective = Perspective.OPERATOR,
) -> list[Placed]:
    return [calculate(o, library, perspective=perspective) for o in outlets]
