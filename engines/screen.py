"""The annual fifteen-category screen.

Every category is screened every year, including the ones that are plainly
not relevant, because SBTi requires a quantified screen rather than an
assertion and ESRS requires a justification for every exclusion. The screen
takes an organisation profile and says, per category, whether it is relevant,
why, and what note a fuel seller must carry against category 11.

Reference: docs/product/nzc-ai-scope-3-brief.md section 3.5.
"""

from __future__ import annotations

from dataclasses import dataclass

from .types import Category

__all__ = ["OrgProfile", "CategoryScreen", "screen"]


@dataclass(frozen=True)
class OrgProfile:
    """The handful of facts the screen turns on."""

    employee_count: int
    sells_fossil_fuel: bool = False
    has_fleet: bool = False
    has_capital_projects: bool = False
    leases_in: bool = False
    leases_out: bool = False
    is_franchisor: bool = False
    sells_physical_products: bool = False
    sold_products_use_energy: bool = False
    sold_products_need_processing: bool = False
    has_investments: bool = False
    has_business_travel: bool = True
    generates_waste: bool = True


@dataclass(frozen=True)
class CategoryScreen:
    category: Category
    relevant: bool
    reason: str
    mandatory_target: bool = False


def screen(profile: OrgProfile) -> list[CategoryScreen]:
    """Screen all fifteen, in category order, with a reason for each."""
    rows: list[CategoryScreen] = [
        CategoryScreen(
            Category.C1_PURCHASED_GOODS,
            True,
            "Every organisation buys goods and services. Screened in.",
        ),
        CategoryScreen(
            Category.C2_CAPITAL_GOODS,
            profile.has_capital_projects,
            "Capital projects in the period."
            if profile.has_capital_projects
            else "No capital projects in the period; quantify as nil with the fixed-asset register as evidence.",
        ),
        CategoryScreen(
            Category.C3_FUEL_ENERGY,
            True,
            "Well-to-tank and transmission losses arise on any purchased energy.",
        ),
        CategoryScreen(
            Category.C4_UPSTREAM_TRANSPORT,
            True,
            "Inbound deliveries of purchased goods.",
        ),
        CategoryScreen(
            Category.C5_WASTE,
            profile.generates_waste,
            "Operational waste." if profile.generates_waste else "No operational waste declared; justify.",
        ),
        CategoryScreen(
            Category.C6_BUSINESS_TRAVEL,
            profile.has_business_travel,
            "Staff travel." if profile.has_business_travel else "No business travel declared; justify.",
        ),
        CategoryScreen(
            Category.C7_COMMUTING,
            profile.employee_count > 0,
            f"{profile.employee_count:,} employees commute."
            if profile.employee_count
            else "No employees.",
        ),
        CategoryScreen(
            Category.C8_UPSTREAM_LEASED,
            profile.leases_in,
            "Leases premises or equipment in where the lessor holds the energy supply."
            if profile.leases_in
            else "No leased-in assets outside Scope 1 and 2.",
        ),
        CategoryScreen(
            Category.C9_DOWNSTREAM_TRANSPORT,
            profile.sells_physical_products,
            "Distribution of sold products after the point of sale."
            if profile.sells_physical_products
            else "No physical products sold onward.",
        ),
        CategoryScreen(
            Category.C10_PROCESSING,
            profile.sold_products_need_processing,
            "Sold intermediate products processed by customers."
            if profile.sold_products_need_processing
            else "Sold products are final; no downstream processing.",
        ),
        CategoryScreen(
            Category.C11_USE_OF_SOLD,
            profile.sells_fossil_fuel or profile.sold_products_use_energy,
            (
                "Combustion of fuel sold. Mandatory separate target under SBTi C22."
                if profile.sells_fossil_fuel
                else "Sold products consume energy in use."
                if profile.sold_products_use_energy
                else "Sold products consume no energy in use."
            ),
            mandatory_target=profile.sells_fossil_fuel,
        ),
        CategoryScreen(
            Category.C12_END_OF_LIFE,
            profile.sells_physical_products,
            "End-of-life treatment of sold products and packaging."
            if profile.sells_physical_products
            else "No physical products sold.",
        ),
        CategoryScreen(
            Category.C13_DOWNSTREAM_LEASED,
            profile.leases_out,
            "Space let to concessions and partners who operate it."
            if profile.leases_out
            else "No assets leased out.",
        ),
        CategoryScreen(
            Category.C14_FRANCHISES,
            profile.is_franchisor,
            "Outlets operated by franchisees under our brand."
            if profile.is_franchisor
            else "We hold no franchisor role. Outlets we operate under others' brands are our own Scope 1 and 2, not category 14.",
        ),
        CategoryScreen(
            Category.C15_INVESTMENTS,
            profile.has_investments,
            "Equity or debt investments in scope."
            if profile.has_investments
            else "No investments held.",
        ),
    ]
    return rows
