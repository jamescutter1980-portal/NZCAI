"""Indicative check of a building against the loaded UK NZCBS limit table.

Mirrors the portal's ``nzcbsAssessment`` (``src/lib/assessment/nzcbs.ts``), with
one adaptation: the portal computes the asset's energy use intensity from meter
readings, and this layer has no meter database, so the caller supplies the values
it has. The governing principle is unchanged and is the reason this tool is worth
having at all:

    No limit, benchmark or asset value is invented.

Where the file sets no limit, or no asset value was supplied, the row is
``not_assessable`` with the reason -- never a pass, and never a limit of zero.
Absent file, sector or year is a reported result rather than an exception,
because "cannot be assessed" is a finding a report needs to carry.
"""

from __future__ import annotations

import re
from typing import Any

from ..uk_nzcbs import DISCLAIMER

NOT_ASSESSABLE_NOTE = (
    "Metrics with no limit in the file or no supplied value are reported as not "
    "assessable, never as a pass."
)


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower())


def is_operational_energy_metric(metric: str) -> bool:
    """The Standard's operational energy intensity metric, however the file spells
    it. Nothing else about the metric list is assumed."""
    m = _norm(metric)
    return "eui" in m or ("operational" in m and "energy" in m) or "energy_use_intensity" in m


def _round(value: float, dp: int = 3) -> float:
    return round(value, dp)


def check(
    *,
    version: str | None,
    file_name: str | None,
    sector: str | None,
    year: int,
    limit_rows: list[dict[str, Any]],
    asset_values: dict[str, float],
    loaded_versions: list[str],
    loaded_sectors: list[str],
    sector_years: list[int],
    reference_dir: str,
    requested_sector: str,
    requested_version: str | None = None,
) -> dict[str, Any]:
    """Compare supplied asset values with the limits for a sector and year.

    ``limit_rows`` are the already-selected rows for this sector and year, each a
    dict of metric/limit_value/unit/year/notes. The caller does the selection so
    this stays pure and testable.
    """
    base: dict[str, Any] = {
        "year": year,
        "sector": sector or (requested_sector or None),
        "version": version,
        "file": file_name,
        "rows": [],
        "counts": {"pass": 0, "fail": 0, "not_assessable": 0},
        "disclaimer": DISCLAIMER,
        "warnings": [],
    }

    if version is None:
        loaded = ", ".join(loaded_versions) or "none"
        reason = (
            f"UK NZCBS version {requested_version} is not loaded (loaded: {loaded}). "
            f"Save it as {requested_version}.csv in {reference_dir}."
            if requested_version
            else f"No UK NZCBS limit file is loaded in {reference_dir}, so there is "
            "nothing to check against."
        )
        return {**base, "assessable": False,
                "summary": "Cannot check against the UK NZCBS: no limit table loaded.",
                "reasons": [reason]}

    if not requested_sector.strip():
        return {**base, "assessable": False,
                "summary": "Cannot check against the UK NZCBS: no sector.",
                "reasons": [
                    "No sector was supplied, so no limits can be selected. Sectors in "
                    f"{version}: {', '.join(loaded_sectors) or 'none'}."
                ]}

    if sector is None:
        return {**base, "assessable": False,
                "summary": (
                    f'Cannot check against the UK NZCBS: sector "{requested_sector}" is '
                    "not in the loaded limit table."
                ),
                "reasons": [
                    f'UK NZCBS {version} has no sector unambiguously matching '
                    f'"{requested_sector}". Sectors loaded: '
                    f"{', '.join(loaded_sectors) or 'none'}."
                ]}

    if not limit_rows:
        years = ", ".join(str(y) for y in sorted(sector_years)) or "none"
        return {**base, "assessable": False,
                "summary": f"Cannot check against the UK NZCBS: no {sector} limits for {year} in {version}.",
                "reasons": [
                    f"UK NZCBS {version} has rows for {sector} but none for {year}. "
                    f"Years in the file for this sector: {years}."
                ]}

    # Asset values are matched on the normalised metric key so a caller need not
    # reproduce the file's exact spelling.
    supplied = {_norm(k): v for k, v in asset_values.items()}

    rows: list[dict[str, Any]] = []
    for limit in limit_rows:
        metric = limit["metric"]
        unit = limit["unit"]
        asset_value = supplied.get(_norm(metric))
        row: dict[str, Any] = {
            "metric": metric,
            "limit_value": limit["limit_value"],
            "unit": unit,
            "year": limit["year"],
            "asset_value": asset_value,
            "notes": limit["notes"],
        }

        if limit["limit_value"] is None:
            when = "" if limit["year"] is None else f" in {limit['year']}"
            row.update(
                status="not_assessable", gap=None,
                reason=(
                    f"The loaded {version} table sets no limit for {sector} / {metric}"
                    f"{when} (blank in the file, which is not a limit of zero)."
                ),
            )
        elif asset_value is None:
            row.update(
                status="not_assessable", gap=None,
                reason=(
                    f'No value was supplied for "{metric}". Supply it from the relevant '
                    "assessment -- a RICS whole life carbon assessment for embodied "
                    "carbon, generation metering for on-site renewables, and so on."
                ),
            )
        else:
            gap = _round(asset_value - limit["limit_value"])
            row.update(
                status="fail" if gap > 0 else "pass", gap=gap,
                reason=(
                    f"Supplied value compared with the {version} limit. Check the "
                    "floor-area basis and scope match the Standard's."
                ),
            )
        rows.append(row)

    counts = {
        "pass": sum(1 for r in rows if r["status"] == "pass"),
        "fail": sum(1 for r in rows if r["status"] == "fail"),
        "not_assessable": sum(1 for r in rows if r["status"] == "not_assessable"),
    }

    headline = next(
        (r for r in rows if is_operational_energy_metric(r["metric"]) and r["status"] != "not_assessable"),
        None,
    )
    summary = (
        f"Indicative check against the loaded UK NZCBS {version} limits for {sector} in "
        f"{year}: {counts['pass']} pass, {counts['fail']} fail, "
        f"{counts['not_assessable']} not assessable"
    )
    if headline:
        direction = "within" if headline["status"] == "pass" else "above"
        summary += (
            f". Operational energy: {headline['asset_value']} against a limit of "
            f"{headline['limit_value']} {headline['unit']} ({direction} the limit by "
            f"{abs(headline['gap'])} {headline['unit']})"
        )
    summary += ". This is not a verified NZCBS assessment."

    warnings = [DISCLAIMER]
    if counts["not_assessable"]:
        warnings.append(NOT_ASSESSABLE_NOTE)

    return {**base, "assessable": True, "sector": sector, "summary": summary,
            "reasons": [], "rows": rows, "counts": counts, "warnings": warnings}
