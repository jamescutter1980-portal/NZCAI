"""Supplier-specific and hybrid figures: the tiers the engagement layer exists to reach.

Two routes in. A counterparty reports its own Scope 1 and 2 and an allocation
basis, and we take our share: tier B, hybrid. Or a counterparty supplies a
product carbon footprint per unit and we multiply by what we bought: tier A,
supplier-specific. Both cite the counterparty as the factor source, so an
auditor sees at once that the number rests on the supplier's word and can go
to the dossier for the document behind it.

Reference: docs/product/nzc-ai-scope-3-brief.md section 3.3 tiers A and B.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional

from .activity import format_quantity
from .factors import convert_quantity
from .types import Category, Figure, Tier

__all__ = [
    "AllocationBasis",
    "PartnerResponse",
    "ProductFootprint",
    "allocate",
    "apply_footprint",
]


class AllocationBasis(str, Enum):
    """How a counterparty's total is shared out among its customers.

    Recorded on every hybrid figure, because a basis that changes between
    periods breaks comparability and the conflict engine watches for it.
    """

    REVENUE_SHARE = "revenue_share"
    VOLUME_SHARE = "volume_share"
    SUPPLIER_STATED = "supplier_stated"


@dataclass(frozen=True)
class PartnerResponse:
    """A counterparty's reported emissions for one period, and our share."""

    counterparty_id: str
    counterparty_name: str
    period: int
    scope1_tco2e: float
    scope2_tco2e: float
    our_share: float
    basis: AllocationBasis
    document_id: Optional[str] = None
    #: Their own upstream Scope 3, where reported. Including it moves the
    #: figure closer to a cradle-to-gate number; excluding it is the
    #: conservative default and the method label says which was done.
    scope3_upstream_tco2e: Optional[float] = None
    verified: bool = False

    def __post_init__(self) -> None:
        if not 0.0 <= self.our_share <= 1.0:
            raise ValueError(f"our_share must be a fraction, got {self.our_share}")
        for name in ("scope1_tco2e", "scope2_tco2e"):
            if getattr(self, name) < 0:
                raise ValueError(f"{name} must not be negative")


@dataclass(frozen=True)
class ProductFootprint:
    """A per-unit footprint a counterparty has supplied for one product."""

    counterparty_id: str
    counterparty_name: str
    item_key: str
    kgco2e_per_unit: float
    unit: str
    version: str
    document_id: Optional[str] = None
    verified: bool = False
    #: Where it came from, for the method label: a PACT payload, an EPD, a
    #: supplier datasheet.
    origin: str = "supplier datasheet"

    def __post_init__(self) -> None:
        if self.kgco2e_per_unit < 0:
            raise ValueError("a footprint cannot be negative")


def allocate(
    response: PartnerResponse,
    *,
    category: Category = Category.C1_PURCHASED_GOODS,
    entity_id: Optional[str] = None,
    include_upstream: bool = False,
) -> Figure:
    """Our share of a counterparty's reported total. Tier B.

    Tier B rather than A because the allocation is ours, not theirs: the
    counterparty reported a total and we chose how much of it is attributable
    to what we bought.
    """
    total = response.scope1_tco2e + response.scope2_tco2e
    scopes = "Scope 1 and 2"
    if include_upstream and response.scope3_upstream_tco2e is not None:
        total += response.scope3_upstream_tco2e
        scopes = "Scope 1, 2 and upstream 3"

    tco2e = total * response.our_share
    verification = "verified" if response.verified else "unverified"

    return Figure(
        category=category,
        tco2e=tco2e,
        tier=Tier.B,
        factor_source=f"{response.counterparty_name} reported {scopes}",
        factor_version=str(response.period),
        counterparty_id=response.counterparty_id,
        document_id=response.document_id,
        achievable_tier=Tier.A,
        entity_id=entity_id,
        activity_quantity=response.our_share,
        activity_unit="share",
        factor_key=f"partner:{response.counterparty_id}:{response.period}",
        factor_kgco2e=total * 1000.0,
        method_label=(
            f"{response.our_share:.2%} of {response.counterparty_name}'s {verification} "
            f"{scopes} total of {total:,.1f} tCO2e for {response.period}, allocated by "
            f"{response.basis.value.replace('_', ' ')}."
        ),
    )


def apply_footprint(
    footprint: ProductFootprint,
    quantity: float,
    unit: str,
    *,
    category: Category = Category.C1_PURCHASED_GOODS,
    entity_id: Optional[str] = None,
) -> Figure:
    """What we bought times the counterparty's own per-unit footprint. Tier A.

    The unit must match the footprint's, or convert exactly. A footprint per
    litre against a quantity in kilograms is exactly the conflict the
    reconciliation engine raises, and this refuses rather than guesses.
    """
    if quantity < 0:
        raise ValueError("quantity must not be negative")
    converted = convert_quantity(quantity, unit, footprint.unit)
    tco2e = converted * footprint.kgco2e_per_unit / 1000.0
    verification = "verified" if footprint.verified else "unverified"

    return Figure(
        category=category,
        tco2e=tco2e,
        tier=Tier.A,
        factor_source=f"{footprint.counterparty_name} product footprint ({footprint.origin})",
        factor_version=footprint.version,
        counterparty_id=footprint.counterparty_id,
        document_id=footprint.document_id,
        achievable_tier=Tier.A,
        entity_id=entity_id,
        activity_quantity=converted,
        activity_unit=footprint.unit,
        factor_key=f"pcf:{footprint.counterparty_id}:{footprint.item_key}",
        factor_kgco2e=footprint.kgco2e_per_unit,
        method_label=(
            f"{format_quantity(converted)} {footprint.unit} of {footprint.item_key} x "
            f"{footprint.kgco2e_per_unit} kgCO2e per {footprint.unit}, {verification} "
            f"footprint from {footprint.counterparty_name} via {footprint.origin}."
        ),
    )
