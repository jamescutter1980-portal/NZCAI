"""Boundary rules: which scope or Scope 3 category an outlet's activity lands in.

The whole of this module exists because a multi-brand site operator holds
several roles at once. On one motorway service area the same company can be a
franchisee of a fast-food brand, a retail partner of a supermarket, a landlord
to a charging concession, and a fuel retailer. Each role sends the same kind of
activity to a different line of the inventory, and getting it wrong is a
restatement.

Reference: docs/product/nzc-ai-scope-3-brief.md section 3.1.
"""

from __future__ import annotations

from dataclasses import dataclass

from .types import (
    ActivityKind,
    Classification,
    OperatorRole,
    Perspective,
)

__all__ = ["Placement", "classify", "franchisor_mirror"]


@dataclass(frozen=True)
class Placement:
    """Where one activity lands, and what justifies putting it there."""

    classification: Classification
    note: str
    #: True where the placement depends on a contractual fact that must be
    #: recorded and evidenced (a concession agreement, a forecourt licence, a
    #: documented pass-through election). The UI surfaces this as a prompt.
    contract_basis_required: bool = False

    @property
    def in_boundary(self) -> bool:
        return self.classification is not Classification.OUT_OF_BOUNDARY


#: Roles where the reporting organisation itself runs the outlet, so energy is
#: its own Scope 1 and 2 and purchases are its own category 1.
_OPERATED_ROLES = frozenset(
    {
        OperatorRole.FRANCHISEE,
        OperatorRole.RETAIL_PARTNER,
        OperatorRole.HOTEL_FRANCHISEE,
        OperatorRole.FUEL_RETAILER,
    }
)

#: Roles where a third party runs the space we own or lease out.
_TENANTED_ROLES = frozenset(
    {
        OperatorRole.LANDLORD_CONCESSION,
        OperatorRole.EV_CHARGING_PARTNER,
    }
)

_OPERATED_BASE: dict[ActivityKind, Classification] = {
    ActivityKind.ENERGY_FUEL: Classification.SCOPE_1,
    ActivityKind.ENERGY_ELECTRICITY: Classification.SCOPE_2,
    ActivityKind.PURCHASES: Classification.CAT_1,
    ActivityKind.WASTE: Classification.CAT_5,
}


def classify(
    role: OperatorRole,
    activity: ActivityKind,
    perspective: Perspective = Perspective.OPERATOR,
    *,
    operator_contracts_waste: bool = False,
    space_leased: bool = True,
    pass_through_elected: bool = False,
) -> Placement:
    """Place one activity at one outlet into the inventory.

    Args:
        role: how the reporting organisation operates this outlet.
        activity: what is being classified.
        perspective: whose inventory is being built. The same tenanted outlet
            is the landlord's category 13 and the occupier's Scope 1 and 2.
        operator_contracts_waste: for a tenanted outlet, whether the landlord
            holds the waste contract. If it does the waste is its category 5
            even though the space is let.
        space_leased: for a charging partner, whether we lease them the space.
            If not, their equipment on our forecourt is outside our boundary.
        pass_through_elected: for owned charging, whether a documented
            pass-through election exists for electricity resold to drivers.

    Returns:
        A Placement carrying the classification, the reason, and whether a
        contractual fact has to be evidenced to support it.

    Raises:
        ValueError: where the combination is not meaningful, for example fuel
            sold at an outlet that does not retail fuel.
    """
    effective_role = _apply_perspective(role, perspective)

    if activity is ActivityKind.FUEL_SOLD:
        return _classify_fuel_sold(effective_role)

    if activity is ActivityKind.ELECTRICITY_SOLD:
        return _classify_electricity_sold(effective_role, pass_through_elected)

    if effective_role in _OPERATED_ROLES:
        return _classify_operated(effective_role, activity)

    if effective_role is OperatorRole.FRANCHISOR:
        return Placement(
            Classification.CAT_14,
            "Outlet operated by a franchisee under our brand licence, so its "
            "energy, purchases and waste are our category 14.",
        )

    if effective_role in _TENANTED_ROLES:
        return _classify_tenanted(
            effective_role,
            activity,
            operator_contracts_waste=operator_contracts_waste,
            space_leased=space_leased,
        )

    if effective_role is OperatorRole.EV_CHARGING_OWNED:
        return _classify_owned_charging(activity)

    raise ValueError(f"no boundary rule for role {effective_role} and activity {activity}")


def _apply_perspective(role: OperatorRole, perspective: Perspective) -> OperatorRole:
    """Re-role an outlet when the inventory is built from the other side.

    A concession the landlord reports in category 13 is the occupier's own
    Scope 1 and 2. Nothing else flips: a franchisee outlet looks the same from
    every angle because the franchisor's mirror is category 14, which
    :func:`franchisor_mirror` handles separately.
    """
    if perspective is Perspective.OCCUPIER and role in _TENANTED_ROLES:
        return OperatorRole.RETAIL_PARTNER
    return role


def _classify_operated(role: OperatorRole, activity: ActivityKind) -> Placement:
    try:
        classification = _OPERATED_BASE[activity]
    except KeyError:  # pragma: no cover - guarded by the callers above
        raise ValueError(f"activity {activity} is not valid for role {role}") from None

    if role is OperatorRole.FUEL_RETAILER and activity is ActivityKind.PURCHASES:
        return Placement(
            Classification.CAT_1,
            "Fuel bought for resale: extraction, refining and well-to-tank sit "
            "in category 1. Combustion by the customer is category 11.",
            contract_basis_required=True,
        )

    if role is OperatorRole.FRANCHISEE:
        return Placement(
            classification,
            "We operate the outlet under a brand licence, so this is ours. "
            "The franchisor counts the same outlet in its category 14.",
        )

    return Placement(classification, "We operate the outlet, so this is ours.")


def _classify_tenanted(
    role: OperatorRole,
    activity: ActivityKind,
    *,
    operator_contracts_waste: bool,
    space_leased: bool,
) -> Placement:
    if role is OperatorRole.EV_CHARGING_PARTNER and not space_leased:
        return Placement(
            Classification.OUT_OF_BOUNDARY,
            "Partner equipment on site under no lease, so outside our boundary. "
            "Record the contractual basis.",
            contract_basis_required=True,
        )

    if activity in (ActivityKind.ENERGY_FUEL, ActivityKind.ENERGY_ELECTRICITY):
        return Placement(
            Classification.CAT_13,
            "Space let to a third party who operates it, so their energy is our "
            "category 13 and their own Scope 1 and 2.",
            contract_basis_required=True,
        )

    if activity is ActivityKind.PURCHASES:
        return Placement(
            Classification.OUT_OF_BOUNDARY,
            "The tenant buys its own goods; they are not in our value chain.",
        )

    if activity is ActivityKind.WASTE:
        if operator_contracts_waste:
            return Placement(
                Classification.CAT_5,
                "We hold the waste contract for the whole site, so the tenant's "
                "waste is our category 5.",
                contract_basis_required=True,
            )
        return Placement(
            Classification.OUT_OF_BOUNDARY,
            "The tenant holds its own waste contract.",
            contract_basis_required=True,
        )

    raise ValueError(f"activity {activity} is not valid for a tenanted outlet")


def _classify_owned_charging(activity: ActivityKind) -> Placement:
    if activity is ActivityKind.ENERGY_ELECTRICITY:
        return Placement(
            Classification.SCOPE_2,
            "Electricity we purchase to run our own chargers is our Scope 2, "
            "including the share we go on to sell to drivers.",
        )
    if activity is ActivityKind.ENERGY_FUEL:
        return Placement(
            Classification.SCOPE_1,
            "Any fuel combusted at the charging hub is our Scope 1.",
        )
    raise ValueError(f"activity {activity} is not valid for owned charging")


def _classify_fuel_sold(role: OperatorRole) -> Placement:
    if role is not OperatorRole.FUEL_RETAILER:
        raise ValueError(
            "fuel sold can only be classified for a fuel retailer; "
            f"got role {role}"
        )
    return Placement(
        Classification.CAT_11,
        "Combustion of fuel we sold. SBTi criterion C22 requires a separate "
        "1.5C-aligned target for this line whatever its share of the total.",
    )


def _classify_electricity_sold(
    role: OperatorRole, pass_through_elected: bool
) -> Placement:
    if role is not OperatorRole.EV_CHARGING_OWNED:
        raise ValueError(
            "electricity sold can only be classified for owned charging; "
            f"got role {role}"
        )
    if pass_through_elected:
        return Placement(
            Classification.OUT_OF_BOUNDARY,
            "Documented pass-through election, so the resold electricity is the "
            "driver's. Disclose the kWh sold and the election.",
            contract_basis_required=True,
        )
    return Placement(
        Classification.OUT_OF_BOUNDARY,
        "Already counted in Scope 2 as purchased electricity. Disclose the kWh "
        "sold, but do not raise a second line or it double counts.",
    )


def franchisor_mirror(role: OperatorRole) -> Classification | None:
    """What the counterparty on the other side of this outlet records.

    Used by the Request Inbox: when a franchisor asks a franchisee for outlet
    data, it is building its own category 14, and knowing that lets the
    response pack be shaped to their question rather than ours.

    Returns None where no mirror obligation arises.
    """
    if role in (OperatorRole.FRANCHISEE, OperatorRole.HOTEL_FRANCHISEE):
        return Classification.CAT_14
    if role in _TENANTED_ROLES:
        return Classification.SCOPE_1
    if role is OperatorRole.FRANCHISOR:
        return Classification.SCOPE_1
    return None
