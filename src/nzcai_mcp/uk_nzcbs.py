"""UK Net Zero Carbon Buildings Standard limits, from the portal's reference files.

Mirrors ``src/lib/integrations/uk-nzcbs/index.ts``: same directory, same columns,
same header detection, same treatment of a blank limit. A reference table, not a
calculation API -- compliance with the Standard needs its own metering,
verification and reporting method, and certification needs an approved verifier.

Limits are transcribed from the published Standard, so they are loaded verbatim
and carry the Standard's attribution. Keep them apart from CRREM pathways: the
Standard sets limits per sector and year, CRREM models a trajectory.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from pathlib import Path

INTEGRATION_ID = "uk-nzcbs"
FILE_PATTERN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)\.csv$")
REQUIRED_COLUMNS = ("version", "sector", "metric", "year", "limit_value", "unit", "notes")
ATTRIBUTION = (
    "Limits and targets: UK Net Zero Carbon Buildings Standard, version as stated. "
    "© UK NZCBS. Transcribed from the published Standard; verify against the current "
    "publication."
)
DISCLAIMER = (
    "Indicative check against the loaded UK NZCBS limit table only. It is not a "
    "verified NZCBS assessment: the Standard's own metering, verification and "
    "reporting method applies, and certification requires an approved verifier. "
    "Limits are as transcribed into the reference file; verify them against the "
    "current publication."
)

_NUMERIC = re.compile(r"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$")


class NzcbsDataError(RuntimeError):
    """Raised only when a loaded file is malformed. A missing file, sector or year
    is a reported result, not an exception -- see ``tools/nzcbs.py``."""


@dataclass(frozen=True)
class LimitRow:
    version: str
    sector: str
    metric: str
    year: int | None
    limit_value: float | None
    unit: str
    notes: str

    @property
    def availability(self) -> str:
        return "available" if self.limit_value is not None else "unavailable"


@dataclass(frozen=True)
class VersionIndex:
    version: str
    file_name: str
    rows: tuple[LimitRow, ...]

    @property
    def sectors(self) -> list[str]:
        return sorted({r.sector for r in self.rows})

    @property
    def metrics(self) -> list[str]:
        return sorted({r.metric for r in self.rows})

    def match_sector(self, sector: str) -> str | None:
        """Exact name first, then a single unambiguous partial match in either
        direction. Two candidates is no match -- the portal will not guess."""
        wanted = sector.strip().lower()
        if not wanted:
            return None
        exact = next((s for s in self.sectors if s.lower() == wanted), None)
        if exact:
            return exact
        partial = [s for s in self.sectors if wanted in s.lower() or s.lower() in wanted]
        return partial[0] if len(partial) == 1 else None


def _numeric(value: str | None) -> float | None:
    if value is None:
        return None
    text = value.strip().replace(",", "")
    return float(text) if text and _NUMERIC.match(text) else None


def parse_limits(text: str, version: str, file_name: str) -> VersionIndex:
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    header_index = next(
        (i for i, row in enumerate(rows) if any(c.strip().lower() == "limit_value" for c in row)),
        None,
    )
    if header_index is None:
        raise NzcbsDataError(f"{file_name}: no header row containing 'limit_value'.")

    header = [c.strip() for c in rows[header_index]]
    lowered = {c.lower() for c in header}
    missing = [c for c in REQUIRED_COLUMNS if c.lower() not in lowered]
    if missing:
        raise NzcbsDataError(f"{file_name}: missing columns {', '.join(missing)}.")

    position = {name.lower(): i for i, name in enumerate(header)}

    def cell(record: list[str], name: str) -> str:
        i = position[name]
        return record[i].strip() if i < len(record) else ""

    parsed: list[LimitRow] = []
    for record in rows[header_index + 1:]:
        if not record or not any(c.strip() for c in record):
            continue
        sector, metric = cell(record, "sector"), cell(record, "metric")
        if not sector or not metric:
            continue
        year = _numeric(cell(record, "year"))
        parsed.append(
            LimitRow(
                version=cell(record, "version") or version,
                sector=sector,
                metric=metric,
                year=int(year) if year is not None else None,
                # Blank is "the Standard sets no limit here", never a limit of zero.
                limit_value=_numeric(cell(record, "limit_value")),
                unit=cell(record, "unit"),
                notes=cell(record, "notes"),
            )
        )
    return VersionIndex(version=version, file_name=file_name, rows=tuple(parsed))


def reference_dir(base: Path) -> Path:
    return base / INTEGRATION_ID


def _version_key(version: str) -> list:
    return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", version)]


def available_versions(base: Path) -> list[str]:
    directory = reference_dir(base)
    if not directory.is_dir():
        return []
    found = [m.group(1) for m in (FILE_PATTERN.match(p.name) for p in directory.glob("*.csv")) if m]
    return sorted(found, key=_version_key, reverse=True)


_cache: dict[Path, tuple[float, int, VersionIndex]] = {}


def load_version(base: Path, version: str | None = None) -> VersionIndex | None:
    """The requested release, or the newest loaded. ``None`` when the file is not
    there -- absence is reported by the caller, not raised."""
    versions = available_versions(base)
    if not versions:
        return None
    chosen = version or versions[0]
    if chosen not in versions:
        return None

    path = reference_dir(base) / f"{chosen}.csv"
    stat = path.stat()
    cached = _cache.get(path)
    if cached and cached[0] == stat.st_mtime and cached[1] == stat.st_size:
        return cached[2]
    index = parse_limits(path.read_text(encoding="utf-8-sig"), chosen, path.name)
    _cache[path] = (stat.st_mtime, stat.st_size, index)
    return index
