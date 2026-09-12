"""CRREM-style stranding analysis.

Pure functions. The decarbonisation pathway is supplied by the caller (loaded
from a dataset by ``server.py``) rather than embedded here — pathways are
licensed, versioned data and must never be hardcoded into the image.
"""

from __future__ import annotations

from typing import Any

from .carbon import CalculationError


def _parse_pathway(pathway: dict[str, float]) -> list[tuple[int, float]]:
    if not pathway:
        raise CalculationError("pathway must contain at least one year")
    rows: list[tuple[int, float]] = []
    for year, limit in pathway.items():
        try:
            rows.append((int(year), float(limit)))
        except (TypeError, ValueError) as exc:
            raise CalculationError(f"pathway entry {year!r}: {limit!r} is not year: number") from exc
    return sorted(rows)


def misalignment_year(
    baseline_intensity_kgco2e_per_m2: float,
    baseline_year: int,
    pathway_kgco2e_per_m2: dict[str, float],
    annual_improvement_rate: float = 0.0,
    floor_area_m2: float | None = None,
) -> dict[str, Any]:
    """Project an asset against a pathway and find the first year it exceeds it.

    ``annual_improvement_rate`` is the compound fractional reduction in the
    asset's own intensity each year (0.02 = 2% per year); leave at zero for a
    do-nothing baseline. Supply ``floor_area_m2`` to also get excess emissions in
    tCO2e rather than intensity units alone.
    """
    if baseline_intensity_kgco2e_per_m2 < 0:
        raise CalculationError("baseline intensity cannot be negative")
    if not 0.0 <= annual_improvement_rate < 1.0:
        raise CalculationError(
            f"annual_improvement_rate must be in [0, 1), got {annual_improvement_rate}"
        )
    if floor_area_m2 is not None and floor_area_m2 <= 0:
        raise CalculationError("floor_area_m2 must be greater than zero when supplied")

    rows = _parse_pathway(pathway_kgco2e_per_m2)
    projection: list[dict[str, Any]] = []
    first_misaligned: int | None = None
    cumulative_excess_kgco2e_per_m2 = 0.0

    for year, limit in rows:
        if year < baseline_year:
            continue
        elapsed = year - baseline_year
        intensity = baseline_intensity_kgco2e_per_m2 * (1 - annual_improvement_rate) ** elapsed
        excess = max(0.0, intensity - limit)
        cumulative_excess_kgco2e_per_m2 += excess
        if excess > 0 and first_misaligned is None:
            first_misaligned = year
        row: dict[str, Any] = {
            "year": year,
            "asset_intensity_kgco2e_per_m2": round(intensity, 2),
            "pathway_limit_kgco2e_per_m2": round(limit, 2),
            "excess_kgco2e_per_m2": round(excess, 2),
            "aligned": excess == 0,
        }
        if floor_area_m2 is not None:
            row["excess_tco2e"] = round(excess * floor_area_m2 / 1000.0, 3)
        projection.append(row)

    if not projection:
        raise CalculationError(
            f"pathway ends in {rows[-1][0]}, before the baseline year {baseline_year}"
        )

    horizon_end = projection[-1]["year"]
    result: dict[str, Any] = {
        "baseline_year": baseline_year,
        "horizon_end": horizon_end,
        "misalignment_year": first_misaligned,
        "aligned_over_horizon": first_misaligned is None,
        "years_to_misalignment": (
            None if first_misaligned is None else first_misaligned - baseline_year
        ),
        "cumulative_excess_kgco2e_per_m2": round(cumulative_excess_kgco2e_per_m2, 2),
        "projection": projection,
    }
    if floor_area_m2 is not None:
        result["cumulative_excess_tco2e"] = round(
            cumulative_excess_kgco2e_per_m2 * floor_area_m2 / 1000.0, 3
        )
    return result
