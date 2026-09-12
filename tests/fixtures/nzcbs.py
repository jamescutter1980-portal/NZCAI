"""A synthetic UK NZCBS limit table for tests.

Mirrors the portal's own vTEST.csv, including the row whose limit is blank —
the Standard setting no limit for that sector/metric, which must never be read
as a limit of zero. Values are marked SYNTHETIC in the notes and use
repeating digits so they cannot be mistaken for published limits.
"""

from __future__ import annotations

from pathlib import Path

LIMITS = "\n".join(
    [
        "version,sector,metric,year,limit_value,unit,notes",
        'vTEST,Office,operational_energy_eui,2025,111.1,kWh/m2/yr,"SYNTHETIC value, GIA basis"',
        "vTEST,Office,operational_energy_eui,2030,99.9,kWh/m2/yr,SYNTHETIC value",
        'vTEST,Office,embodied_upfront,2025,555.5,kgCO2e/m2,"SYNTHETIC value, A1-A5"',
        "vTEST,Office,onsite_renewables,,,kWh/m2/yr,SYNTHETIC: no limit set in this fixture",
        "vTEST,Retail,operational_energy_eui,2025,222.2,kWh/m2/yr,SYNTHETIC value",
        # Rows the loader skips: no sector, no metric.
        "vTEST,,operational_energy_eui,2025,1.1,kWh/m2/yr,skipped",
        "vTEST,Office,,2025,1.1,kWh/m2/yr,skipped",
        "",
    ]
)


def write_limits(base: Path, version: str = "vTEST", text: str = LIMITS) -> Path:
    directory = base / "uk-nzcbs"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{version}.csv"
    path.write_text(text, encoding="utf-8")
    return path
