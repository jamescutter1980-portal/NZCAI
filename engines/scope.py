"""What we still need from a counterparty, after everything we already have.

Ask last: a request goes out only for the fields that enrichment and prior
periods did not satisfy. This engine computes that list per counterparty and
category, and the tier the answer would reach, so the request can say exactly
what it wants and the scoring engine knows what a reply is worth.

Reference: docs/product/nzc-ai-scope-3-engagement-brief.md section 14, scope.py.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping

from .types import Category, Counterparty, RelationshipRole as R, Tier

__all__ = [
    "DataNeed",
    "ROLE_CATEGORIES",
    "REQUIRED_FIELDS",
    "categories_served",
    "compute_need",
    "compute_needs",
]


#: Which categories a relationship of each role can supply data for.
ROLE_CATEGORIES: dict[R, frozenset[Category]] = {
    R.SUPPLIER: frozenset({Category.C1_PURCHASED_GOODS, Category.C2_CAPITAL_GOODS}),
    R.DISTRIBUTOR: frozenset({Category.C1_PURCHASED_GOODS, Category.C4_UPSTREAM_TRANSPORT}),
    R.LOGISTICS: frozenset({Category.C4_UPSTREAM_TRANSPORT, Category.C9_DOWNSTREAM_TRANSPORT}),
    R.WASTE_CONTRACTOR: frozenset({Category.C5_WASTE}),
    R.FUEL_SUPPLIER: frozenset({Category.C1_PURCHASED_GOODS, Category.C3_FUEL_ENERGY}),
    R.LANDLORD: frozenset({Category.C8_UPSTREAM_LEASED}),
    R.FRANCHISOR: frozenset({Category.C1_PURCHASED_GOODS}),
    R.FRANCHISEE: frozenset({Category.C14_FRANCHISES}),
    R.CONCESSION_TENANT: frozenset({Category.C13_DOWNSTREAM_LEASED}),
    R.CHARGING_PARTNER: frozenset({Category.C13_DOWNSTREAM_LEASED}),
    R.CUSTOMER: frozenset(),
    R.LENDER: frozenset(),
    R.PARENT: frozenset(),
}

#: Fields that, once held, lift a category to its best tier. The first entry
#: of each tuple is the one that reaches tier A where a distinction exists.
REQUIRED_FIELDS: dict[Category, tuple[str, ...]] = {
    Category.C1_PURCHASED_GOODS: (
        "product_footprints",
        "scope1_total",
        "scope2_total",
        "allocation_basis",
        "our_share",
    ),
    Category.C2_CAPITAL_GOODS: ("product_footprints", "scope1_total", "scope2_total", "allocation_basis"),
    Category.C3_FUEL_ENERGY: ("well_to_tank_factor",),
    Category.C4_UPSTREAM_TRANSPORT: ("tonne_km", "vehicle_class", "fuel_litres"),
    Category.C5_WASTE: ("tonnes_by_route", "treatment_evidence"),
    Category.C8_UPSTREAM_LEASED: ("recharged_kwh_by_fuel", "floor_area"),
    Category.C9_DOWNSTREAM_TRANSPORT: ("tonne_km", "vehicle_class"),
    Category.C13_DOWNSTREAM_LEASED: ("meter_kwh_by_fuel", "floor_area", "consent"),
    Category.C14_FRANCHISES: ("outlet_kwh_by_fuel", "outlet_waste_tonnes", "outlet_floor_area"),
}

#: Fields whose presence alone reaches tier A for the category.
_TIER_A_FIELDS: dict[Category, frozenset[str]] = {
    Category.C1_PURCHASED_GOODS: frozenset({"product_footprints"}),
    Category.C2_CAPITAL_GOODS: frozenset({"product_footprints"}),
    Category.C13_DOWNSTREAM_LEASED: frozenset({"meter_kwh_by_fuel"}),
    Category.C14_FRANCHISES: frozenset({"outlet_kwh_by_fuel"}),
    Category.C5_WASTE: frozenset({"tonnes_by_route"}),
}


@dataclass(frozen=True)
class DataNeed:
    counterparty_id: str
    period: int
    category: Category
    required: tuple[str, ...]
    satisfied: tuple[str, ...]
    outstanding: tuple[str, ...]
    achievable_tier: Tier

    @property
    def complete(self) -> bool:
        return not self.outstanding

    @property
    def nothing_to_ask(self) -> bool:
        """True where a request would add nothing: all held, or no fields defined."""
        return self.complete or not self.required


def categories_served(roles: Iterable[R]) -> frozenset[Category]:
    """Every category a counterparty with these roles could supply data for."""
    out: set[Category] = set()
    for role in roles:
        out |= ROLE_CATEGORIES.get(role, frozenset())
    return frozenset(out)


def compute_need(
    counterparty: Counterparty,
    period: int,
    category: Category,
    satisfied_fields: Iterable[str],
) -> DataNeed:
    """The outstanding fields for one category, and the tier they would reach.

    Tier A needs the category's tier-A field. Tier B needs everything else
    required. The tier is what a *complete* reply would reach, so the scoring
    engine can value it; an incomplete reply lands where the fields it did
    supply put it, which the partner engine decides at calculation time.
    """
    required = REQUIRED_FIELDS.get(category, ())
    held = frozenset(satisfied_fields)
    satisfied = tuple(f for f in required if f in held)
    outstanding = tuple(f for f in required if f not in held)

    tier_a_fields = _TIER_A_FIELDS.get(category, frozenset())
    if tier_a_fields and (tier_a_fields & held or tier_a_fields <= set(required)):
        achievable = Tier.A
    elif required:
        achievable = Tier.B
    else:
        achievable = Tier.C

    return DataNeed(
        counterparty_id=counterparty.id,
        period=period,
        category=category,
        required=required,
        satisfied=satisfied,
        outstanding=outstanding,
        achievable_tier=achievable,
    )


def compute_needs(
    counterparty: Counterparty,
    period: int,
    satisfied_by_category: Mapping[Category, Iterable[str]],
) -> list[DataNeed]:
    """Needs for every category this counterparty's roles can serve, in order."""
    served = categories_served(counterparty.roles)
    return [
        compute_need(counterparty, period, category, satisfied_by_category.get(category, ()))
        for category in sorted(served, key=lambda c: int(c.value))
    ]
