"""Per-outlet packs for reporting upward to a franchisor.

A franchisor building its own category 14 asks each franchisee for restaurant
level energy, emissions and waste, usually on its own template. Every field it
wants already exists in the site ledger; what is missing is the shaping. This
engine produces the pack so the Request Inbox can answer from the ledger
rather than a spreadsheet, and so the figure sent to the franchisor is the
same one sent to the parent.

Reference: docs/product/nzc-ai-scope-3-brief.md section 7, franchisor packs;
           docs/product/nzc-ai-scope-3-engagement-brief.md section 11.1.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

from .factors import FactorLibrary
from .leased import OutletEnergy

__all__ = ["OutletPack", "outlet_pack", "brand_pack"]


@dataclass(frozen=True)
class OutletPack:
    """One outlet, shaped for a franchisor's annual request."""

    outlet_id: str
    brand: str
    period: int
    floor_area_m2: Optional[float]
    fuel_kwh: float
    electricity_kwh: float
    total_kwh: float
    scope1_tco2e: float
    scope2_tco2e: float
    total_tco2e: float
    waste_tonnes: Optional[float]
    kwh_per_m2: Optional[float]
    kgco2e_per_m2: Optional[float]
    allocation_method: str
    factor_versions: tuple[str, ...]

    def as_row(self) -> dict[str, object]:
        """A flat row, the shape most franchisor templates want."""
        return {
            "outlet_id": self.outlet_id,
            "brand": self.brand,
            "period": self.period,
            "floor_area_m2": self.floor_area_m2,
            "fuel_kwh": round(self.fuel_kwh),
            "electricity_kwh": round(self.electricity_kwh),
            "total_kwh": round(self.total_kwh),
            "scope1_tco2e": round(self.scope1_tco2e, 2),
            "scope2_tco2e": round(self.scope2_tco2e, 2),
            "total_tco2e": round(self.total_tco2e, 2),
            "waste_tonnes": self.waste_tonnes,
            "kwh_per_m2": round(self.kwh_per_m2, 1) if self.kwh_per_m2 is not None else None,
            "kgco2e_per_m2": round(self.kgco2e_per_m2, 2) if self.kgco2e_per_m2 is not None else None,
            "allocation_method": self.allocation_method,
            "factor_versions": ", ".join(self.factor_versions),
        }


def outlet_pack(
    outlet: OutletEnergy,
    library: FactorLibrary,
    *,
    brand: str,
    floor_area_m2: Optional[float] = None,
    waste_tonnes: Optional[float] = None,
    electricity_factor_key: str = "electricity_uk_grid",
    fuel_factor_key: str = "natural_gas",
) -> OutletPack:
    """Shape one franchised outlet for the franchisor's request.

    From the franchisee's side this is its own Scope 1 and 2, so the pack
    reports them as such. The franchisor will file the same numbers under its
    category 14; that is its boundary decision, not ours.
    """
    elec = library.get(electricity_factor_key)
    fuel = library.get(fuel_factor_key)

    fuel_kwh = outlet.fuel_kwh * outlet.allocation_share
    elec_kwh = outlet.electricity_kwh * outlet.allocation_share
    scope1 = fuel.tco2e_for(fuel_kwh, "kWh")
    scope2 = elec.tco2e_for(elec_kwh, "kWh")
    total_kwh = fuel_kwh + elec_kwh
    total_t = scope1 + scope2

    per_m2_kwh = per_m2_kg = None
    if floor_area_m2 and floor_area_m2 > 0:
        per_m2_kwh = total_kwh / floor_area_m2
        per_m2_kg = total_t * 1000.0 / floor_area_m2

    return OutletPack(
        outlet_id=outlet.outlet_id,
        brand=brand,
        period=outlet.period,
        floor_area_m2=floor_area_m2,
        fuel_kwh=fuel_kwh,
        electricity_kwh=elec_kwh,
        total_kwh=total_kwh,
        scope1_tco2e=scope1,
        scope2_tco2e=scope2,
        total_tco2e=total_t,
        waste_tonnes=waste_tonnes,
        kwh_per_m2=per_m2_kwh,
        kgco2e_per_m2=per_m2_kg,
        allocation_method=outlet.allocation_method,
        factor_versions=tuple(sorted({f"{f.source} {f.version}" for f in (elec, fuel)})),
    )


def brand_pack(packs: Iterable[OutletPack]) -> dict[str, object]:
    """Totals across every outlet of one brand, for the franchisor's cover row.

    Intensities are recomputed from totals rather than averaged, so an outlet
    with no floor area on record does not distort the brand figure.
    """
    packs = list(packs)
    if not packs:
        return {"outlets": 0}
    brands = {p.brand for p in packs}
    if len(brands) != 1:
        raise ValueError(f"brand_pack expects one brand, got {sorted(brands)}")

    total_kwh = sum(p.total_kwh for p in packs)
    total_t = sum(p.total_tco2e for p in packs)
    area = sum(p.floor_area_m2 for p in packs if p.floor_area_m2)
    with_area = [p for p in packs if p.floor_area_m2]

    return {
        "brand": brands.pop(),
        "period": packs[0].period,
        "outlets": len(packs),
        "outlets_with_floor_area": len(with_area),
        "total_kwh": round(total_kwh),
        "total_tco2e": round(total_t, 2),
        "kwh_per_m2": round(sum(p.total_kwh for p in with_area) / area, 1) if area else None,
        "kgco2e_per_m2": round(sum(p.total_tco2e for p in with_area) * 1000 / area, 2) if area else None,
        "waste_tonnes": sum(p.waste_tonnes for p in packs if p.waste_tonnes is not None) or None,
        "factor_versions": sorted({v for p in packs for v in p.factor_versions}),
    }
