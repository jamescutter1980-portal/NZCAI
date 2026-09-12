"""A synthetic CRREM pathway file for tests.

Mirrors the portal's own vTEST.csv fixture, repeating-digit values (5.555, 4.444)
so it can never be mistaken for published CRREM data. Includes the blank-value
year and the quoted property type with a comma, both of which the real files have.
"""

from __future__ import annotations

from pathlib import Path

PATHWAYS = "\n".join(
    [
        "version,country_code,property_type,pathway_type,scenario,year,value,unit",
        "vTEST,GB,Office,ghg,1.5C,2025,5.555,kgCO2e/m2",
        "vTEST,GB,Office,ghg,1.5C,2026,4.444,kgCO2e/m2",
        "vTEST,GB,Office,ghg,1.5C,2027,3.333,kgCO2e/m2",
        "vTEST,GB,Office,ghg,1.5C,2028,,kgCO2e/m2",
        "vTEST,GB,Office,ghg,1.5C,2029,1.111,kgCO2e/m2",
        "vTEST,GB,Office,ghg,2C,2025,6.666,kgCO2e/m2",
        "vTEST,GB,Office,ghg,2C,2026,6.000,kgCO2e/m2",
        "vTEST,GB,Office,energy,1.5C,2025,111.1,kWh/m2",
        "vTEST,GB,Office,energy,1.5C,2026,100.1,kWh/m2",
        'vTEST,GB,"Retail, High Street",ghg,1.5C,2025,7.777,kgCO2e/m2',
        # Unplaceable rows: the loader skips these rather than failing the file.
        "vTEST,GB,Office,ghg,3C,2025,9.999,kgCO2e/m2",
        "vTEST,GB,Office,nonsense,1.5C,2025,9.999,kgCO2e/m2",
        "vTEST,GB,Office,ghg,1.5C,not-a-year,9.999,kgCO2e/m2",
        "",
    ]
)


def write_pathways(base: Path, version: str = "vTEST", text: str = PATHWAYS) -> Path:
    directory = base / "crrem-pathways"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{version}.csv"
    path.write_text(text, encoding="utf-8")
    return path
