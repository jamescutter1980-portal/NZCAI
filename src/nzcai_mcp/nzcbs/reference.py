"""UK Net Zero Carbon Buildings Standard, Version 1, Rev 1: reference tables and
the equations the Standard writes out.

Mirrors the portal's ``src/lib/nzcbs`` (``reference.ts`` for the loader and limit
lookup; the equation helpers in ``aspects/``). The same test vectors,
``tests/nzcbs/vectors.json``, run against both, so the two layers cannot drift.

The tables ship in two places and are read from either:

- the deployment's ``<REFERENCE_DATA_DIR>/uk-nzcbs/<version>/`` for revisions
  supplied after this code shipped;
- the bundled copy: ``nzcai_mcp/bundled_reference/uk-nzcbs/<version>/`` inside
  the installed wheel, or ``reference/uk-nzcbs/<version>/`` at the repository root
  when running from source.

Every file's SHA-256 is checked against ``manifest.json``; an edited table is
refused rather than used. Limits are the publisher's material and carry its
attribution. "No limit" is a status, never a zero.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

INTEGRATION_ID = "uk-nzcbs"
FILES = ("limits.csv", "renewables_targets.csv", "other_limits.csv", "reduction_curves.csv", "menus.csv")
MANIFEST = "manifest.json"
ATTRIBUTION = (
    "Limits and targets: UK Net Zero Carbon Buildings Standard, Version 1, Rev 1 (April 2026), "
    "© Net Zero Carbon Buildings Standard Ltd. Converted from the published submission "
    "proforma; verify against the current publication."
)
STANDARD_NAME = "UK Net Zero Carbon Buildings Standard"
PRE_VERIFICATION_STATEMENT = f"targeting verification to the {STANDARD_NAME}"
DISCLAIMER = (
    f"Pre-verification comparison against the {STANDARD_NAME}. It is not a verified claim: "
    "conformity requires measured performance over a full Operational Reporting Period, "
    "submission through the Submission Proforma and verification by an approved verifier "
    "through NZCBS Ltd (sections 4.3, 6 and 7). Until then the building may only be "
    f'described as "{PRE_VERIFICATION_STATEMENT}".'
)

LIMIT_TABLE_FIRST_YEAR = 2025
LIMIT_TABLE_LAST_YEAR = 2050
MINIMUM_OCCUPANCY_RATE = 0.8
REFRIGERANT_CHARGE_REPORTING_THRESHOLD_KGCO2E = 3000
DHCN_ASHP_SCOP = 2.8
DHCN_PRIMARY_DISTRIBUTION_LOSSES = 0.2
DHCN_PARASITIC_ENERGY = 0.02
DHCN_CHILLER_SEER = 3
NEW_BUILDING_NIA_SHARE = 0.5
RETROFIT_ENVELOPE_SHARE = 0.1
REPORTABLE_WORKS_VALUE_GBP = 100_000


class NzcbsDataError(RuntimeError):
    """A loaded file is malformed or fails its checksum. A missing version, sector
    or year is a reported result, not an exception."""


# --------------------------------------------------------------------------- #
# data                                                                         #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class LimitRow:
    table: str
    aspect: str
    sector: str
    subsector: str
    scope: str
    label: str
    area_basis: str
    year: int
    value: float | None
    unit: str
    status: str
    note: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "table": self.table, "sector": self.sector, "subsector": self.subsector, "scope": self.scope,
            "area_basis": self.area_basis, "year": self.year, "value": self.value, "unit": self.unit,
            "status": self.status, "note": self.note,
        }


@dataclass(frozen=True)
class RenewablesTarget:
    region: str
    building_group: str
    value: float
    unit: str


@dataclass(frozen=True)
class OtherLimit:
    value: float | None
    unit: str
    source: str
    note: str


@dataclass(frozen=True)
class Version:
    version: str
    dir: Path
    bundled: bool


@dataclass
class Reference:
    version: str
    dir: Path
    bundled: bool
    manifest: dict[str, Any]
    limits: list[LimitRow]
    renewables_targets: list[RenewablesTarget]
    other_limits: dict[str, OtherLimit]
    reduction_curves: list[dict[str, float]]
    menus: dict[str, list[str]]
    modified_at: float
    sectors: list[str] = field(default_factory=list)

    @property
    def file_name(self) -> str:
        return str(self.dir / "limits.csv")

    def label(self) -> str:
        where = "bundled" if self.bundled else "deployment"
        return (
            f"UK NZCBS {self.version} ({self.manifest.get('standard', '')}); {where} reference "
            f"tables, manifest {self.manifest.get('converted_on', '')}"
        )


# --------------------------------------------------------------------------- #
# discovery                                                                    #
# --------------------------------------------------------------------------- #


def deployment_reference_dir(base: Path) -> Path:
    return base / INTEGRATION_ID


def bundled_reference_dir() -> Path:
    override = os.environ.get("NZCBS_BUNDLED_REFERENCE_DIR", "").strip()
    if override:
        return Path(override) / INTEGRATION_ID
    package_root = Path(__file__).resolve().parents[1]  # nzcai_mcp/
    packaged = package_root / "bundled_reference" / INTEGRATION_ID
    if packaged.is_dir():
        return packaged
    # Running from source: <repo>/src/nzcai_mcp/nzcbs/reference.py -> <repo>/reference
    return package_root.parents[1] / "reference" / INTEGRATION_ID


_VERSION_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _version_key(version: str) -> list:
    return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", version)]


def _folders(root: Path, bundled: bool) -> list[Version]:
    if not root.is_dir():
        return []
    out = []
    for child in root.iterdir():
        if child.is_dir() and _VERSION_NAME.match(child.name) and (child / MANIFEST).is_file():
            out.append(Version(child.name, child, bundled))
    return out


def list_versions(base: Path) -> list[Version]:
    """Newest first. A deployment folder shadows a bundled one of the same name."""
    by_name: dict[str, Version] = {}
    for v in _folders(bundled_reference_dir(), True):
        by_name[v.version] = v
    for v in _folders(deployment_reference_dir(base), False):
        by_name[v.version] = v
    return sorted(by_name.values(), key=lambda v: _version_key(v.version), reverse=True)


# --------------------------------------------------------------------------- #
# loading                                                                      #
# --------------------------------------------------------------------------- #

_cache: dict[Path, tuple[float, Reference]] = {}
_NUMERIC = re.compile(r"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$")


def _number(text: str | None) -> float | None:
    if text is None:
        return None
    t = text.strip().replace(",", "")
    return float(t) if t and _NUMERIC.match(t) else None


def _read_checked(directory: Path, manifest: dict[str, Any], name: str) -> list[dict[str, str]]:
    path = directory / name
    if not path.is_file():
        raise NzcbsDataError(f"{directory}: {name} is missing.")
    raw = path.read_bytes()
    expected = (manifest.get("files") or {}).get(name, {}).get("sha256")
    if not expected:
        raise NzcbsDataError(f"{directory}: manifest.json has no checksum for {name}.")
    if hashlib.sha256(raw).hexdigest() != expected:
        raise NzcbsDataError(
            f"{directory}: {name} does not match its manifest checksum, so it has been edited "
            "since conversion and is refused. Re-run the converter or restore the file."
        )
    text = raw.decode("utf-8-sig")
    return list(csv.DictReader(text.splitlines()))


def load_reference(base: Path, version: str | None = None) -> Reference | None:
    versions = list_versions(base)
    chosen = next((v for v in versions if v.version == version), None) if version else (versions[0] if versions else None)
    if chosen is None:
        return None
    manifest_path = chosen.dir / MANIFEST
    mtime = manifest_path.stat().st_mtime
    cached = _cache.get(chosen.dir)
    if cached and cached[0] == mtime:
        return cached[1]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for name in FILES:
        if name not in (manifest.get("files") or {}):
            raise NzcbsDataError(f"{chosen.dir}: manifest.json does not list {name}.")
    limits = [
        LimitRow(
            table=r["table"], aspect=r["aspect"], sector=r["sector"], subsector=r["subsector"], scope=r["scope"],
            label=r["label"], area_basis=r["area_basis"], year=int(r["year"]), value=_number(r["value"]),
            unit=r["unit"], status=r["status"], note=r["note"],
        )
        for r in _read_checked(chosen.dir, manifest, "limits.csv")
    ]
    targets = [
        RenewablesTarget(r["region"], r["building_group"], float(r["value"]), r["unit"])
        for r in _read_checked(chosen.dir, manifest, "renewables_targets.csv")
    ]
    other = {
        r["key"]: OtherLimit(_number(r["value"]), r["unit"], r["source"], r["note"])
        for r in _read_checked(chosen.dir, manifest, "other_limits.csv")
    }
    curves = [
        {"year": float(r["year"]), "residential": float(r["residential"]), "non_residential": float(r["non_residential"])}
        for r in _read_checked(chosen.dir, manifest, "reduction_curves.csv")
    ]
    menus: dict[str, list[str]] = {}
    for r in _read_checked(chosen.dir, manifest, "menus.csv"):
        menus.setdefault(r["menu"], []).append(r["value"])
    ref = Reference(
        version=chosen.version, dir=chosen.dir, bundled=chosen.bundled, manifest=manifest, limits=limits,
        renewables_targets=targets, other_limits=other, reduction_curves=curves, menus=menus, modified_at=mtime,
        sectors=sorted({r.sector for r in limits}),
    )
    _cache[chosen.dir] = (mtime, ref)
    return ref


def clear_cache() -> None:
    _cache.clear()


# --------------------------------------------------------------------------- #
# limit lookup                                                                 #
# --------------------------------------------------------------------------- #


@dataclass
class LimitResolution:
    status: str
    value: float | None
    unit: str
    year: int
    row: LimitRow | None
    candidates: list[LimitRow]
    notes: list[str]

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status, "value": self.value, "unit": self.unit, "year": self.year,
            "row": self.row.as_dict() if self.row else None,
            "candidates": [c.as_dict() for c in self.candidates], "notes": self.notes,
        }


def clamp_limit_year(year: int | float) -> int:
    """5.2.7.1: before 2025 reads as 2025; Annex A plateaus after 2050."""
    if not isinstance(year, (int, float)) or not math.isfinite(year):
        return LIMIT_TABLE_FIRST_YEAR
    return min(LIMIT_TABLE_LAST_YEAR, max(LIMIT_TABLE_FIRST_YEAR, int(year)))


def _norm(s: str | None) -> str:
    return (s or "").strip().lower()


def _describe(rows: list[LimitRow]) -> str:
    seen: list[str] = []
    for r in rows:
        key = " / ".join(p for p in (r.subsector, r.scope, r.area_basis) if p) or "sector"
        val = f"{r.value} {r.unit}" if r.status == "limit" else r.status
        item = f"{key}={val}"
        if item not in seen:
            seen.append(item)
    return "; ".join(seen)


def find_limit(
    ref: Reference, *, table: str, sector: str, year: int,
    subsector: str | None = None, scope: str | None = None, area_basis: str | None = None,
) -> LimitResolution:
    """The one limit row for a table, sector and year. Subsector, scope and area
    basis narrow the choice; a sector-level figure serves any subsector; two
    different figures that both fit is reported as ambiguous, never guessed."""
    y = clamp_limit_year(year)
    notes: list[str] = []
    if y != year:
        notes.append(f"Year {year} is outside the published range, so the {y} limit is used (5.2.7.1, Annex A).")
    rows = [r for r in ref.limits if r.table == table and _norm(r.sector) == _norm(sector) and r.year == y]
    if not rows:
        sectors = sorted({r.sector for r in ref.limits if r.table == table})
        notes.append(f'Table {table} has no rows for sector "{sector}". Sectors in the table: {", ".join(sectors)}.')
        return LimitResolution("not_found", None, "", y, None, [], notes)

    want_sub, want_scope, want_basis = _norm(subsector), _norm(scope), _norm(area_basis)
    scored: list[tuple[LimitRow, int]] = []
    for row in rows:
        score = 0
        rs = _norm(row.subsector)
        if want_sub:
            if rs == want_sub:
                score += 30
            elif rs == "":
                score += 20
            else:
                continue
        else:
            score += 30 if rs == "" else 10
        rsc = _norm(row.scope)
        if want_scope:
            if rsc == want_scope:
                score += 3
            elif rsc == "":
                score += 2
            else:
                continue
        else:
            score += 3 if rsc in ("", "whole building") else 1
        rab = _norm(row.area_basis)
        if want_basis:
            if rab in (want_basis, "pue", ""):
                score += 200
            else:
                continue
        else:
            score += 100 if rab == "nia" else 200
        scored.append((row, score))

    if not scored:
        notes.append(
            f'Table {table}, {sector}: no row matches subsector "{subsector or ""}", scope "{scope or ""}" '
            f'and basis "{area_basis or ""}". Rows available: {_describe(rows)}.'
        )
        return LimitResolution("not_found", None, rows[0].unit, y, None, rows, notes)
    best = max(s for _, s in scored)
    top = [r for r, s in scored if s == best]
    if len({(r.status, r.value, r.unit) for r in top}) > 1:
        needs = " and scope" if any(r.scope for r in top) else ""
        notes.append(f"Table {table}, {sector}: more than one limit fits ({_describe(top)}). Give the subsector{needs}.")
        return LimitResolution("ambiguous", None, top[0].unit, y, None, top, notes)
    row = top[0]
    if row.note:
        notes.append(row.note)
    return LimitResolution(row.status, row.value, row.unit, y, row, top, notes)


def renewables_target(ref: Reference, region: str, group: str) -> RenewablesTarget | None:
    return next((t for t in ref.renewables_targets if t.region == region and t.building_group == group), None)


def other_limit(ref: Reference, key: str) -> OtherLimit | None:
    return ref.other_limits.get(key)


# --------------------------------------------------------------------------- #
# equations                                                                    #
# --------------------------------------------------------------------------- #


def _round(x: float, dp: int = 3) -> float:
    return round(x + 0.0, dp)


def grid_factor(generation: float, transmission_and_distribution: float, wtt_generation: float, wtt_transmission_and_distribution: float) -> float:
    """5.2.3.4: the four DESNZ lines summed."""
    return _round(generation + transmission_and_distribution + wtt_generation + wtt_transmission_and_distribution, 6)


def occupancy_rate(total_gia_m2: float, unoccupiable_gia_m2: float, occupied_gia_m2: float) -> float | None:
    """Equation 4."""
    at = total_gia_m2 - unoccupiable_gia_m2
    if at <= 0:
        return None
    return _round(occupied_gia_m2 / at, 4)


def equation_1a(parts: list[tuple[float, float]]) -> float:
    """Sector-weighted limit: sum of share x limit (4.2.5.2)."""
    return _round(sum(share * limit for share, limit in parts))


def equation_1b(new_share: float, ln: float, le: float) -> float:
    """Area-weighted limit for 10% to 50% New Area (4.2.5.2)."""
    return _round(new_share * ln + (1 - new_share) * le + new_share * (ln - le))


def equation_5(target: float, unconstrained_area_m2: float, footprint_m2: float) -> float:
    """Reduced renewables target; never increased (5.3.5.1)."""
    if footprint_m2 <= 0:
        return target
    return _round(target * min(1.0, unconstrained_area_m2 / footprint_m2))


def network_limit(service: str, existing: bool, grid_factor_kgco2e_per_kwh: float) -> dict[str, Any]:
    """Equations 6a, 6b, 7a, 7b (5.7.6)."""
    g = grid_factor_kgco2e_per_kwh
    if service == "cooling":
        value = _round((1 / DHCN_CHILLER_SEER) * g, 4)
        return {"value": value, "equation": "6b" if existing else "7b"}
    if existing:
        value = _round(((1 + DHCN_PRIMARY_DISTRIBUTION_LOSSES) / DHCN_ASHP_SCOP + (1 + DHCN_PRIMARY_DISTRIBUTION_LOSSES) * DHCN_PARASITIC_ENERGY) * g, 4)
        return {"value": value, "equation": "6a"}
    return {"value": _round((1 / DHCN_ASHP_SCOP) * g, 4), "equation": "7a"}


def network_energy_use(generation_input_kwh: float, distribution_input_kwh: float, metered_kwh: float, system_delivered_kwh: float) -> float | None:
    """Equation 2a."""
    if system_delivered_kwh <= 0:
        return None
    return _round((generation_input_kwh + distribution_input_kwh) * (metered_kwh / system_delivered_kwh))


def network_carbon_factor(generation_kgco2e: float, distribution_kgco2e: float, system_delivered_kwh: float, recovered_heat_kgco2e: float = 0.0) -> float | None:
    """Equation 2b, with recovered heat at zero (5.7.3.3)."""
    if system_delivered_kwh <= 0:
        return None
    return _round((max(0.0, generation_kgco2e - recovered_heat_kgco2e) + distribution_kgco2e) / system_delivered_kwh, 4)


def refrigerant_charge_kgco2e(systems: list[dict[str, Any]]) -> float:
    """Equation 8."""
    return _round(sum(float(s["chargeKg"]) * float(s["gwp"]) for s in systems))


def leakage_kg(system: dict[str, Any]) -> tuple[float | None, str | None]:
    """Equation 9a where start, added and end are known; 9b where only added is."""
    start, added, end = system.get("startChargeKg"), system.get("addedKg"), system.get("endChargeKg")
    if start is not None and added is not None and end is not None:
        return _round(float(start) + float(added) - float(end), 4), "9a"
    if added is not None:
        return _round(float(added), 4), "9b"
    return None, None


def percentile_inclusive(sorted_ascending: list[float], p: float) -> float | None:
    """Spreadsheet PERCENTILE.INC."""
    n = len(sorted_ascending)
    if n == 0:
        return None
    if n == 1:
        return sorted_ascending[0]
    rank = p * (n - 1)
    lo, hi = math.floor(rank), math.ceil(rank)
    return sorted_ascending[lo] + (sorted_ascending[hi] - sorted_ascending[lo]) * (rank - lo)


def demand_statistics(interval_kwh: list[float], resolution_minutes: int) -> dict[str, Any]:
    """5.6.3: top ten demand values, P50 and P1 in kW across the whole period."""
    per_hour = 60 / resolution_minutes
    kw = sorted(_round(k * per_hour) for k in interval_kwh)
    return {
        "top_ten_kw": list(reversed(kw))[:10],
        "p50_kw": _round(percentile_inclusive(kw, 0.5)) if kw else None,
        "p1_kw": _round(percentile_inclusive(kw, 0.01)) if kw else None,
        "intervals": len(kw),
    }


def works_type(facts: dict[str, Any] | None) -> str:
    """Table 5."""
    f = facts or {}
    if (f.get("newNiaShare") or 0) >= NEW_BUILDING_NIA_SHARE or f.get("singleStoreyAllNewAboveSlab"):
        return "New Works"
    if (f.get("thermalEnvelopeShareReplaced") or 0) >= RETROFIT_ENVELOPE_SHARE or (f.get("glazedAreaShareReplaced") or 0) >= RETROFIT_ENVELOPE_SHARE:
        return "Retrofit Works"
    if f.get("firstFitOut"):
        return "Non-Reportable Works"
    if (f.get("valueGbp") or 0) >= REPORTABLE_WORKS_VALUE_GBP or f.get("newOrReplacedHvacPlant") or f.get("replacedLightingSystems"):
        return "Reportable Works"
    return "Non-Reportable Works"


_PROHIBITED = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"net zero carbon aligned",
        r"\baligned (with|to) the (uk )?(net zero carbon buildings )?standard",
        r"\bcompliant with (the )?(uk )?nzcbs",
        r"\bcompliant with the (uk )?net zero carbon buildings standard",
        r"\bcertified (to|against) (the )?(uk )?(nzcbs|net zero carbon buildings standard)",
        r"\bnzcbs[- ](compliant|certified|aligned|verified)",
        r"\bconforms? (to|with) the (uk )?net zero carbon buildings standard",
    )
]


def contains_prohibited_claim(text: str) -> bool:
    """7.4.1 and 7.5."""
    return any(p.search(text) for p in _PROHIBITED)


def operational_table(building_type: str, route: str) -> str:
    """5.2.7.1: which Annex A energy table applies."""
    if building_type == "New Building":
        return "OE-1"
    return "OE-3" if route == "stepped" else "OE-2"
