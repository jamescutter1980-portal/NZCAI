"""A synthetic DESNZ flat file for tests.

The factor values are deliberately absurd (9.9x) so a fixture can never be
mistaken for published data, following the convention the portal's reference
fixtures use. The shape -- title rows before the header, a per-gas breakdown
alongside the total row, a blank factor -- mirrors the real file.
"""

from __future__ import annotations

from pathlib import Path

HEADER = (
    "ID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,"
    "GHG Conversion Factor 2025,Lookup"
)

# Two title rows before the header, as the real sheet has.
FLAT_FILE = "\n".join(
    [
        "UK Government GHG Conversion Factors for Company Reporting,,,,,,,,,,",
        "Factors by Category,,,,,,,,,,",
        HEADER,
        # Electricity generation: total row plus a per-gas row that must not win.
        "1001,Scope 2,UK electricity,Electricity generated,,,,kWh,kg CO2e,9.910,x",
        "1002,Scope 2,UK electricity,Electricity generated,,CO2,CO2,kWh,kg CO2e,9.900,x",
        # Transmission and distribution.
        "2001,Scope 3,Transmission and distribution,T&D- UK electricity,,,,kWh,kg CO2e,9.020,x",
        # Natural gas, gross CV.
        "3001,Scope 1,Fuels,Gaseous fuels,Natural gas,,,kWh (Gross CV),kg CO2e,9.500,x",
        # Gas oil, addressable only by row id -- there is no built-in selector.
        "4001,Scope 1,Fuels,Liquid fuels,Gas oil,,,kWh (Gross CV),kg CO2e,9.700,x",
        # Published as not available: a blank cell, which must never read as zero.
        "5001,Scope 1,Fuels,Solid fuels,Unavailable fuel,,,kWh (Gross CV),kg CO2e,,x",
        # A thousands separator, which the published file does use.
        "6001,Scope 3,Business travel,Air,Long haul,,,passenger.km,kg CO2e,\"1,234.5\",x",
        "",
    ]
)


def write_flat_file(base: Path, year: int = 2025, text: str = FLAT_FILE) -> Path:
    """Write the fixture where the loader expects it: <base>/desnz-conversion-factors/<year>.csv"""
    directory = base / "desnz-conversion-factors"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{year}.csv"
    path.write_text(text, encoding="utf-8")
    return path
