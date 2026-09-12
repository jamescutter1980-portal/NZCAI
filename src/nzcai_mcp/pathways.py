"""CRREM decarbonisation pathways, read from the portal's reference files.

Mirrors ``src/lib/integrations/crrem-pathways/index.ts``: same directory, same
columns, same scenario spellings, same treatment of a blank value. Pathways are
model outputs (SDA-derived targets), so they carry basis "modelled" -- they are
not measurements.

CRREM pathways are licensed. They are supplied per deployment and never
committed, and the attribution below rides on every result, because software-use
rights must be confirmed with CRREM before pathway values reach a client
deliverable.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from pathlib import Path

INTEGRATION_ID = "crrem-pathways"
FILE_PATTERN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)\.csv$")
REQUIRED_COLUMNS = (
    "version", "country_code", "property_type", "pathway_type",
    "scenario", "year", "value", "unit",
)
ATTRIBUTION = (
    "Pathways: CRREM (Carbon Risk Real Estate Monitor), version as stated. "
    "© CRREM / IIÖ. Used under the CRREM terms of use."
)
LICENCE_NOTE = (
    "CRREM pathways are licensed, not open data. Confirm software-use rights with "
    "CRREM before pathway values reach a commercial tool or a client deliverable."
)

_NUMERIC = re.compile(r"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$")


class PathwayDataError(RuntimeError):
    """Raised when no pathway file, version or series matches."""


@dataclass(frozen=True)
class PathwayPoint:
    version: str
    country_code: str
    property_type: str
    pathway_type: str
    scenario: str
    year: int
    value: float | None
    unit: str


@dataclass(frozen=True)
class VersionIndex:
    version: str
    file_name: str
    points: tuple[PathwayPoint, ...]

    @property
    def countries(self) -> list[str]:
        return sorted({p.country_code for p in self.points})

    @property
    def property_types(self) -> list[str]:
        return sorted({p.property_type for p in self.points})

    def select(
        self, country_code: str, property_type: str, pathway_type: str, scenario: str
    ) -> tuple[PathwayPoint, ...]:
        country = country_code.strip().upper()
        prop = property_type.strip().lower()
        return tuple(
            p for p in self.points
            if p.country_code == country
            and p.property_type.lower() == prop
            and p.pathway_type == pathway_type
            and p.scenario == scenario
        )


def _numeric(value: str | None) -> float | None:
    if value is None:
        return None
    text = value.strip().replace(",", "")
    return float(text) if text and _NUMERIC.match(text) else None


def normalise_scenario(raw: str) -> str | None:
    """The published files spell the scenarios several ways; the portal accepts
    all of these, so this does too."""
    text = re.sub(r"\s+", "", raw).replace("°", "").upper()
    if text in {"1.5C", "1.5", "1.5DEGC", "1,5C"}:
        return "1.5C"
    if text in {"2C", "2", "2.0C", "2DEGC"}:
        return "2C"
    return None


def parse_pathways(text: str, version: str, file_name: str) -> VersionIndex:
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    header_index = next(
        (i for i, row in enumerate(rows) if any(c.strip().lower() == "property_type" for c in row)),
        None,
    )
    if header_index is None:
        raise PathwayDataError(f"{file_name}: no header row containing 'property_type'.")

    header = [c.strip() for c in rows[header_index]]
    lowered = {c.lower() for c in header}
    missing = [c for c in REQUIRED_COLUMNS if c.lower() not in lowered]
    if missing:
        raise PathwayDataError(f"{file_name}: missing columns {', '.join(missing)}.")

    position = {name.lower(): i for i, name in enumerate(header)}

    def cell(record: list[str], name: str) -> str:
        i = position[name]
        return record[i].strip() if i < len(record) else ""

    points: list[PathwayPoint] = []
    for record in rows[header_index + 1:]:
        if not record or not any(c.strip() for c in record):
            continue
        year = _numeric(cell(record, "year"))
        scenario = normalise_scenario(cell(record, "scenario"))
        pathway_type = cell(record, "pathway_type").lower()
        # A row that cannot be placed on an axis is skipped, as the portal does,
        # rather than failing the whole file.
        if year is None or scenario is None or pathway_type not in {"ghg", "energy"}:
            continue
        points.append(
            PathwayPoint(
                version=cell(record, "version") or version,
                country_code=cell(record, "country_code").upper(),
                property_type=cell(record, "property_type"),
                pathway_type=pathway_type,
                scenario=scenario,
                year=int(year),
                value=_numeric(cell(record, "value")),
                unit=cell(record, "unit"),
            )
        )
    points.sort(key=lambda p: p.year)
    return VersionIndex(version=version, file_name=file_name, points=tuple(points))


def reference_dir(base: Path) -> Path:
    return base / INTEGRATION_ID


def _version_key(version: str) -> list:
    """Sort v2.10 after v2.9, matching the portal's numeric-aware compare."""
    return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", version)]


def available_versions(base: Path) -> list[str]:
    directory = reference_dir(base)
    if not directory.is_dir():
        return []
    found = [m.group(1) for m in (FILE_PATTERN.match(p.name) for p in directory.glob("*.csv")) if m]
    return sorted(found, key=_version_key, reverse=True)


_cache: dict[Path, tuple[float, int, VersionIndex]] = {}


def load_version(base: Path, version: str | None = None) -> VersionIndex:
    """Load a CRREM release, defaulting to the newest loaded one."""
    versions = available_versions(base)
    if not versions:
        raise PathwayDataError(
            f"No CRREM pathway files loaded in {reference_dir(base)}. Export the pathway "
            "tables from the CRREM tool to <version>.csv (e.g. v2.04.csv) with columns "
            "version, country_code, property_type, pathway_type, scenario, year, value, "
            "unit. See docs/integrations/reference-data.md."
        )
    chosen = version or versions[0]
    if chosen not in versions:
        raise PathwayDataError(
            f"CRREM version {chosen!r} is not loaded (loaded: {', '.join(versions)}). "
            f"Save it as {chosen}.csv in {reference_dir(base)}."
        )

    path = reference_dir(base) / f"{chosen}.csv"
    stat = path.stat()
    cached = _cache.get(path)
    if cached and cached[0] == stat.st_mtime and cached[1] == stat.st_size:
        return cached[2]
    index = parse_pathways(path.read_text(encoding="utf-8-sig"), chosen, path.name)
    _cache[path] = (stat.st_mtime, stat.st_size, index)
    return index


def require_series(
    index: VersionIndex, country_code: str, property_type: str, pathway_type: str, scenario: str
) -> tuple[PathwayPoint, ...]:
    series = index.select(country_code, property_type, pathway_type, scenario)
    if not series:
        raise PathwayDataError(
            f"No {scenario} {pathway_type} pathway for {country_code.strip().upper()} / "
            f"{property_type} in CRREM {index.version}. Loaded property types: "
            f"{', '.join(index.property_types) or 'none'}; countries: "
            f"{', '.join(index.countries) or 'none'}."
        )
    return series
