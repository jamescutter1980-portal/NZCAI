"""DESNZ conversion factors, read from the same flat file the portal reads.

The portal resolves every Scope 1 and 2 factor from the annual DESNZ "flat file
for automatic processing" and never carries its own copy of a factor value
(``src/lib/carbon/factors.ts``). The MCP layer now does the same, against the
same file in the same place, so there is one source of truth and one thing to
update each June.

File layout, header detection and cell semantics follow
``docs/integrations/reference-data.md``. The important rule:

    A blank factor means "not available" and is never read as 0.

DESNZ republished the 2026 flat file in July 2026 because unavailable factors
had been shown as 0, so a blank cell yields ``None`` and any calculation that
would consume it fails loudly instead of silently costing nothing.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

INTEGRATION_ID = "desnz-conversion-factors"
FILE_PATTERN = re.compile(r"^(\d{4})\.csv$")
REQUIRED_COLUMNS = (
    "ID", "Scope", "Level 1", "Level 2", "Level 3", "Level 4",
    "Column Text", "UOM", "GHG/Unit",
)
FACTOR_PREFIX = "GHG Conversion Factor"

# Matches the portal's parseNumericCell: thousands separators stripped, anything
# that is not a plain number left as unavailable rather than coerced.
_NUMERIC = re.compile(r"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$")


class ReferenceDataError(RuntimeError):
    """Raised when the flat file is missing, malformed, or lacks a needed row."""


@dataclass(frozen=True)
class FactorRow:
    id: str
    scope: str
    level1: str
    level2: str
    level3: str
    level4: str
    column_text: str
    uom: str
    ghg_unit: str
    factor: float | None
    factor_text: str
    year: int

    @property
    def availability(self) -> str:
        return "available" if self.factor is not None else "unavailable"

    @property
    def is_total_row(self) -> bool:
        """The reporting total, as opposed to a per-gas breakdown row."""
        return not self.level4 and not self.column_text

    def describe(self) -> str:
        parts = [p for p in (self.level1, self.level2, self.level3, self.level4) if p]
        return " / ".join(parts) or self.id


@dataclass(frozen=True)
class FactorSelector:
    """Row selector, matched case-insensitively on the level and unit text."""

    level1: str
    uom: str
    ghg_unit: str
    level2: str | None = None
    level3: str | None = None


# The three selectors the portal defines. Deliberately not extended by guesswork:
# inventing level text for another fuel would be fabricating a lookup into a file
# this code cannot see. Anything else is addressed by its published row id.
SELECTORS: dict[str, FactorSelector] = {
    "electricity_generated": FactorSelector(
        level1="UK electricity", level2="Electricity generated",
        uom="kWh", ghg_unit="kg CO2e",
    ),
    "electricity_td": FactorSelector(
        level1="Transmission and distribution", level2="T&D- UK electricity",
        uom="kWh", ghg_unit="kg CO2e",
    ),
    "natural_gas_gross": FactorSelector(
        level1="Fuels", level2="Gaseous fuels", level3="Natural gas",
        uom="kWh (Gross CV)", ghg_unit="kg CO2e",
    ),
}


@dataclass(frozen=True)
class YearIndex:
    year: int
    file_name: str
    factor_column: str
    rows: tuple[FactorRow, ...]

    def by_id(self, row_id: str) -> FactorRow | None:
        wanted = row_id.strip()
        return next((r for r in self.rows if r.id == wanted), None)

    def find(self, selector: FactorSelector) -> FactorRow | None:
        matches = [r for r in self.rows if _matches(r, selector)]
        # Prefer the reporting total over a per-gas breakdown row.
        return next((r for r in matches if r.is_total_row), matches[0] if matches else None)


def _norm(value: str) -> str:
    return re.sub(r"\s+", " ", value.lower()).replace("–", "-").replace("—", "-").strip()


def _matches(row: FactorRow, selector: FactorSelector) -> bool:
    if _norm(row.level1) != _norm(selector.level1):
        return False
    if selector.level2 is not None and _norm(row.level2) != _norm(selector.level2):
        return False
    if selector.level3 is not None and _norm(row.level3) != _norm(selector.level3):
        return False
    return _norm(row.uom) == _norm(selector.uom) and _norm(row.ghg_unit) == _norm(selector.ghg_unit)


def parse_numeric_cell(value: str | None) -> float | None:
    """A blank cell is unavailable, never zero. A published 0 is a genuine zero."""
    if value is None:
        return None
    text = value.strip().replace(",", "")
    if not text or not _NUMERIC.match(text):
        return None
    return float(text)


def parse_flat_file(text: str, year: int, file_name: str) -> YearIndex:
    # The sheet carries title rows before the header, so the header is the row
    # whose first cell is "ID".
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    header_index = next(
        (i for i, row in enumerate(rows) if row and row[0].strip().upper() == "ID"), None
    )
    if header_index is None:
        raise ReferenceDataError(
            f"{file_name}: no header row found. Expected the DESNZ flat file "
            "'Factors by Category' sheet exported as CSV, whose header begins with 'ID'."
        )

    header = [cell.strip() for cell in rows[header_index]]
    lowered = {cell.lower() for cell in header}
    missing = [c for c in REQUIRED_COLUMNS if c.lower() not in lowered]
    if missing:
        raise ReferenceDataError(f"{file_name}: missing columns {', '.join(missing)}.")

    factor_column = next((h for h in header if h.startswith(FACTOR_PREFIX)), None)
    if factor_column is None:
        raise ReferenceDataError(f"{file_name}: no '{FACTOR_PREFIX} <year>' column found.")

    index = {name: i for i, name in enumerate(header)}

    def cell(record: list[str], name: str) -> str:
        position = index[name]
        return record[position].strip() if position < len(record) else ""

    parsed: list[FactorRow] = []
    for record in rows[header_index + 1:]:
        if not record or not any(c.strip() for c in record):
            continue
        row_id = cell(record, "ID")
        if not row_id:
            continue
        factor_text = cell(record, factor_column)
        parsed.append(
            FactorRow(
                id=row_id,
                scope=cell(record, "Scope"),
                level1=cell(record, "Level 1"),
                level2=cell(record, "Level 2"),
                level3=cell(record, "Level 3"),
                level4=cell(record, "Level 4"),
                column_text=cell(record, "Column Text"),
                uom=cell(record, "UOM"),
                ghg_unit=cell(record, "GHG/Unit"),
                factor=parse_numeric_cell(factor_text),
                factor_text=factor_text,
                year=year,
            )
        )
    return YearIndex(year=year, file_name=file_name, factor_column=factor_column, rows=tuple(parsed))


def reference_dir(base: Path) -> Path:
    return base / INTEGRATION_ID


def available_years(base: Path) -> list[int]:
    directory = reference_dir(base)
    if not directory.is_dir():
        return []
    return sorted(
        int(m.group(1)) for m in (FILE_PATTERN.match(p.name) for p in directory.glob("*.csv")) if m
    )


# Parsed once and cached until the file's mtime or size changes, so replacing a
# file takes effect without a restart -- the rule the portal's loader follows.
_cache: dict[Path, tuple[float, int, YearIndex]] = {}


def load_year(base: Path, year: int) -> YearIndex:
    path = reference_dir(base) / f"{year}.csv"
    if not path.is_file():
        years = available_years(base)
        loaded = ", ".join(str(y) for y in years) if years else "none"
        raise ReferenceDataError(
            f"No DESNZ {year} flat file loaded (loaded: {loaded}). Export the "
            f"'Factors by Category' sheet of the DESNZ {year} flat file to CSV and save it "
            f"as {path}. See docs/integrations/reference-data.md."
        )

    stat = path.stat()
    cached = _cache.get(path)
    if cached and cached[0] == stat.st_mtime and cached[1] == stat.st_size:
        return cached[2]

    index = parse_flat_file(path.read_text(encoding="utf-8-sig"), year, path.name)
    _cache[path] = (stat.st_mtime, stat.st_size, index)
    return index


def citation(index: YearIndex, rows: Iterable[FactorRow]) -> str:
    """Publication, year, row ids and file, so a number can be traced to its source."""
    ids = ", ".join(row.id for row in rows)
    return f"DESNZ {index.year} row {ids} ({index.file_name})"


@dataclass(frozen=True)
class ResolvedFactor:
    """A factor value with the published rows it was built from."""

    fuel: str
    value: float
    unit: str
    rows: tuple[FactorRow, ...]

    def provenance(self, index: YearIndex) -> dict:
        return {
            "reference": citation(index, self.rows),
            "rows": [
                {"id": r.id, "scope": r.scope, "description": r.describe(),
                 "factor": r.factor, "unit": f"{r.ghg_unit}/{r.uom}"}
                for r in self.rows
            ],
        }


def resolve_fuel_factors(
    index: YearIndex,
    fuels: Iterable[str],
    row_ids: dict[str, str] | None = None,
) -> dict[str, ResolvedFactor]:
    """Resolve each fuel to a kgCO2e/kWh factor from the loaded flat file.

    ``electricity`` and ``natural_gas`` use the selectors the portal defines. Any
    other fuel must name a published row id in ``row_ids`` -- the same escape
    hatch the portal gives activities that can point at any factor. Nothing is
    guessed: an unresolvable fuel is an error naming what is missing.
    """
    row_ids = row_ids or {}
    resolved: dict[str, ResolvedFactor] = {}

    for fuel in fuels:
        explicit = row_ids.get(fuel)
        if explicit is not None:
            row = index.by_id(explicit)
            if row is None:
                raise ReferenceDataError(
                    f"row {explicit!r} is not in the {index.year} flat file "
                    f"({index.file_name}). Factor ids change between years, so re-pick "
                    "the factor for this year; search_emission_factors lists them."
                )
            _require_available(row, index)
            resolved[fuel] = ResolvedFactor(
                fuel, row.factor, f"{row.ghg_unit}/{row.uom}", (row,)
            )
            continue

        if fuel == "electricity":
            # Location-based Scope 2 is generation plus transmission and
            # distribution; the WTT rows are Scope 3 and deliberately excluded.
            rows = tuple(
                _require_row(index, SELECTORS[key], key)
                for key in ("electricity_generated", "electricity_td")
            )
            for row in rows:
                _require_available(row, index)
            resolved[fuel] = ResolvedFactor(
                fuel, sum(r.factor for r in rows), "kg CO2e/kWh", rows
            )
        elif fuel == "natural_gas":
            row = _require_row(index, SELECTORS["natural_gas_gross"], "natural_gas_gross")
            _require_available(row, index)
            resolved[fuel] = ResolvedFactor(
                fuel, row.factor, f"{row.ghg_unit}/{row.uom}", (row,)
            )
        else:
            raise ReferenceDataError(
                f"no published selector for fuel {fuel!r}: give its DESNZ row id in "
                "factor_row_ids. Use search_emission_factors to find the row."
            )

    return resolved


def _require_row(index: YearIndex, selector: FactorSelector, label: str) -> FactorRow:
    row = index.find(selector)
    if row is None:
        raise ReferenceDataError(
            f"no row matching {label} ({selector.level1} / {selector.level2}) in the "
            f"{index.year} flat file ({index.file_name})."
        )
    return row


def _require_available(row: FactorRow, index: YearIndex) -> None:
    """A blank factor is published as unavailable and must never be read as 0."""
    if row.factor is None:
        raise ReferenceDataError(
            f"DESNZ {index.year} row {row.id} ({row.describe()}) is published as not "
            "available, so it has no factor. It must not be treated as zero."
        )
