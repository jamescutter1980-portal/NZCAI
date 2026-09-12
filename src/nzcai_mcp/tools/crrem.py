"""CRREM misalignment (stranding) year.

Pure functions. The pathway is supplied by the caller, loaded from the licensed
reference file by ``pathways.py`` -- never embedded here.

The method matches the portal's ``computeMisalignment``: the misalignment year is
the first year the asset intensity exceeds the pathway. A single asset value is
held **constant** across the pathway years. That is a static projection, not the
CRREM tool's method -- it ignores grid decarbonisation and any planned measures --
so it is reported as a warning rather than dressed up with an assumed rate of
improvement. For a CRREM-consistent answer the caller supplies the projected
series.
"""

from __future__ import annotations

from typing import Any, Iterable, Sequence

STATIC_PROJECTION_WARNING = (
    "Single asset value held constant across all years (static projection). Supply a "
    "projected series for a CRREM-consistent misalignment year."
)
BASIS_WARNING = (
    "Check floor-area basis, scope and grid factor assumptions match the pathway "
    "before reporting."
)


class CalculationError(ValueError):
    """Raised when inputs cannot produce a meaningful result."""


def misalignment_year(
    pathway: Sequence[tuple[int, float | None]],
    asset_series: Iterable[tuple[int, float]],
    floor_area_m2: float | None = None,
) -> dict[str, Any]:
    """Compare an asset's intensity series against a pathway.

    ``pathway`` is (year, value) with ``None`` where the file publishes no value.
    ``asset_series`` is (year, value); a single pair is held constant across every
    pathway year.
    """
    if not pathway:
        raise CalculationError("pathway must contain at least one year")
    asset = sorted(asset_series)
    if not asset:
        raise CalculationError("asset_series must contain at least one year and value")
    if any(value < 0 for _, value in asset):
        raise CalculationError("asset intensity cannot be negative")
    if floor_area_m2 is not None and floor_area_m2 <= 0:
        raise CalculationError("floor_area_m2 must be greater than zero when supplied")

    by_year = dict(pathway)
    years = sorted(by_year)
    asset_constant = len(asset) == 1
    series = [(year, asset[0][1]) for year in years] if asset_constant else asset

    rows: list[dict[str, Any]] = []
    first_misaligned: int | None = None
    cumulative_excess = 0.0
    skipped_years: list[int] = []

    for year, value in series:
        if year not in by_year:
            skipped_years.append(year)
            continue
        limit = by_year[year]
        if limit is None:
            # Published without a value: never read as zero, so the year is
            # reported and skipped rather than counted as an exceedance.
            rows.append({
                "year": year, "asset_value": round(value, 3),
                "pathway_value": None, "excess": None, "status": "no_pathway_value",
            })
            continue
        excess = value - limit
        misaligned = excess > 0
        if misaligned and first_misaligned is None:
            first_misaligned = year
        if misaligned:
            cumulative_excess += excess
        row: dict[str, Any] = {
            "year": year,
            "asset_value": round(value, 3),
            "pathway_value": round(limit, 3),
            "excess": round(excess, 6),
            "status": "misaligned" if misaligned else "aligned",
        }
        if floor_area_m2 is not None:
            row["excess_tco2e"] = round(max(0.0, excess) * floor_area_m2 / 1000.0, 3)
        rows.append(row)

    warnings: list[str] = []
    if asset_constant:
        warnings.append(STATIC_PROJECTION_WARNING)
    if skipped_years:
        warnings.append(
            f"Asset years outside the pathway were ignored: "
            f"{', '.join(str(y) for y in skipped_years)}."
        )
    if any(r["status"] == "no_pathway_value" for r in rows):
        warnings.append("Some pathway years carry no value in the file and were skipped.")
    warnings.append(BASIS_WARNING)

    compared = [r for r in rows if r["status"] != "no_pathway_value"]
    result: dict[str, Any] = {
        "misalignment_year": first_misaligned,
        "aligned_over_horizon": first_misaligned is None and bool(compared),
        "pathway_first_year": years[0],
        "pathway_last_year": years[-1],
        "years_compared": len(compared),
        "asset_held_constant": asset_constant,
        "cumulative_excess_per_m2": round(cumulative_excess, 3),
        "projection": rows,
        "warnings": warnings,
    }
    if floor_area_m2 is not None:
        result["cumulative_excess_tco2e"] = round(cumulative_excess * floor_area_m2 / 1000.0, 3)
    if not compared:
        result["detail"] = (
            f"No overlap: the asset series shares no year carrying a pathway value with "
            f"the pathway ({years[0]}-{years[-1]}), so no misalignment year can be computed."
        )
    return result
