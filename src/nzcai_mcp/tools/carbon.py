"""Operational carbon calculations.

Pure functions — no MCP or I/O imports — so the arithmetic can be unit tested
without a server or a container. ``server.py`` loads the factor set and passes
the values in.
"""

from __future__ import annotations

from typing import Any

KG_PER_TONNE = 1000.0


class CalculationError(ValueError):
    """Raised when inputs cannot produce a meaningful result."""


def calculate_carbon_intensity(
    consumption_kwh: dict[str, float],
    floor_area_m2: float,
    factors_kgco2e_per_kwh: dict[str, float],
    market_based_electricity_factor: float | None = None,
) -> dict[str, Any]:
    """Convert metered consumption into emissions and floor-area intensities.

    ``consumption_kwh`` maps a fuel key (``electricity``, ``natural_gas``, ...) to
    annual kWh. ``market_based_electricity_factor`` supplies the supplier-specific
    figure for dual Scope 2 reporting; omit it and only the location-based result
    is returned.
    """
    if floor_area_m2 <= 0:
        raise CalculationError(f"floor_area_m2 must be greater than zero, got {floor_area_m2}")
    if not consumption_kwh:
        raise CalculationError("consumption_kwh must contain at least one fuel")

    unknown = sorted(set(consumption_kwh) - set(factors_kgco2e_per_kwh))
    if unknown:
        known = ", ".join(sorted(factors_kgco2e_per_kwh))
        raise CalculationError(
            f"no emission factor for {', '.join(unknown)}; factor set covers: {known}"
        )

    negative = sorted(fuel for fuel, kwh in consumption_kwh.items() if kwh < 0)
    if negative:
        raise CalculationError(f"consumption cannot be negative: {', '.join(negative)}")

    by_fuel = {
        fuel: round(kwh * factors_kgco2e_per_kwh[fuel], 2)
        for fuel, kwh in consumption_kwh.items()
    }
    total_kwh = sum(consumption_kwh.values())
    total_kgco2e = sum(by_fuel.values())

    result: dict[str, Any] = {
        "total_consumption_kwh": round(total_kwh, 2),
        "energy_use_intensity_kwh_per_m2": round(total_kwh / floor_area_m2, 2),
        "emissions_by_fuel_kgco2e": by_fuel,
        "location_based": {
            "total_tco2e": round(total_kgco2e / KG_PER_TONNE, 3),
            "carbon_intensity_kgco2e_per_m2": round(total_kgco2e / floor_area_m2, 2),
        },
    }

    if market_based_electricity_factor is not None:
        electricity_kwh = consumption_kwh.get("electricity", 0.0)
        market_kgco2e = (
            total_kgco2e
            - by_fuel.get("electricity", 0.0)
            + electricity_kwh * market_based_electricity_factor
        )
        result["market_based"] = {
            "total_tco2e": round(market_kgco2e / KG_PER_TONNE, 3),
            "carbon_intensity_kgco2e_per_m2": round(market_kgco2e / floor_area_m2, 2),
            "electricity_factor_kgco2e_per_kwh": market_based_electricity_factor,
        }

    return result
