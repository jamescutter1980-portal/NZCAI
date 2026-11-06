#!/usr/bin/env python3
"""Convert the UK NZCBS V1 Rev 1 limit tables, as extracted from the rev03
submission proforma, into the tidy reference files the portal and the MCP
layer load from reference/uk-nzcbs/<version>/.

Usage:
    python3 scripts/nzcbs/convert-proforma-tables.py <source-dir> <out-dir>

<source-dir> holds the proforma-shaped CSVs (embodied_carbon_new_works.csv,
energy_use_new_build.csv, ... menus.csv, other_limits.csv). <out-dir> is the
version folder, e.g. reference/uk-nzcbs/v1r1.

What it does, and why each rule exists:

- Keeps every sector and subsector string as the proforma prints it, apart from
  collapsing doubled spaces ("Higher  Education").
- Splits a column label into subsector and scope only where the suffix is one
  of the scopes the Standard uses (Whole building, Shell & Core + Cat A, Shell &
  Core only, Cat A + Cat B, Cat B, Landlord-only, Tenant-only). "Food & beverage
  - no commercial kitchen" is a subsector name and is never split.
- Embodied carbon tables (EC-1 to EC-3): a subsector column that is blank for
  every year inherits the nearest earlier column of the same sector. Annex A
  publishes one limit per sector (Offices and Storage split by scope only), and
  the proforma shows that as a merged cell. Each inherited row is noted.
- "no limit" is status no_limit; "n/a" is not_applicable; "As per NHS-NZ
  Standard" is deferred; an empty cell with a header is unavailable. None of
  these is ever written as 0.
- Writes a manifest with a SHA-256 per output file so a loader can refuse an
  edited table.

The script is deliberately strict: an unexpected header layout stops it.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import sys
from datetime import date

SCOPES = [
    "Shell & Core + Cat A",
    "Shell & Core only",
    "Cat A + Cat B",
    "Whole building",
    "Landlord-only",
    "Tenant-only",
    "Landlord",
    "Tenant",
    "Cat B",
]
SCOPE_CANON = {"Landlord": "Landlord-only", "Tenant": "Tenant-only", "Cat A+B": "Cat A + Cat B"}

# table id, aspect, source file, header layout
TABLES = [
    ("EC-1", "embodied_carbon", "embodied_carbon_new_works.csv", "ec"),
    ("EC-2", "embodied_carbon", "embodied_carbon_retrofit.csv", "ec"),
    ("EC-3", "embodied_carbon", "embodied_carbon_reportable.csv", "ec"),
    ("OE-1", "operational_energy", "energy_use_new_build.csv", "oe"),
    ("OE-2", "operational_energy", "energy_use_retrofit.csv", "oe"),
    ("OE-3", "operational_energy", "energy_use_stepped_retrofit.csv", "oe"),
    ("OE-4", "space_heating", "space_heating_new_builds.csv", "oe"),
]
NIA_GROUPS = {"Offices - New Build": "OE-1", "Offices - Retrofit": "OE-2", "Office - Stepped Retrofit": "OE-3"}

NUMERIC = re.compile(r"^[-+]?(\d+\.?\d*|\.\d+)$")


def squash(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())


def read(path: str) -> list[list[str]]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        return [[c for c in r] for r in csv.reader(f)]


def cell(rows: list[list[str]], r: int, c: int) -> str:
    return squash(rows[r][c]) if r < len(rows) and c < len(rows[r]) else ""


def split_label(label: str, sector: str) -> tuple[str, str]:
    """(subsector, scope). Returns scope "" when the label carries none."""
    label = squash(label)
    if label in SCOPE_CANON and sector:
        return "", SCOPE_CANON[label]
    for scope in SCOPES:
        suffix = f" - {scope}"
        if label.endswith(suffix):
            return label[: -len(suffix)], SCOPE_CANON.get(scope, scope)
    return label, ""


def classify(value: str, unit: str) -> tuple[str, str | None, str]:
    """(status, numeric value, note)."""
    v = squash(value)
    if v == "":
        return "unavailable", None, "Blank in the published table (not a limit of zero)."
    if NUMERIC.match(v):
        return "limit", v, ""
    low = v.lower()
    if low == "no limit":
        return "no_limit", None, "The Standard sets no limit for this sector in this version."
    if low == "n/a":
        return "not_applicable", None, "Not applicable to this sector."
    if low.startswith("as per nhs"):
        return "deferred", None, "New Healthcare buildings follow the NHS Net Zero Building Standard (Table 10 and 5.2.7.1)."
    raise SystemExit(f"Unrecognised cell value {value!r}")


def convert_table(table: str, aspect: str, rows: list[list[str]], layout: str) -> list[dict]:
    if layout == "ec":
        sector_row, label_row, unit_row, first = 1, 2, 3, 4
    else:
        sector_row, label_row, unit_row, first = 0, 1, 2, 3
    if not cell(rows, label_row, 0).lower().startswith("date of commencement"):
        raise SystemExit(f"{table}: unexpected header layout")
    ncols = max(len(r) for r in rows)
    sectors: list[str] = []
    last = ""
    for c in range(ncols):
        s = cell(rows, sector_row, c)
        if s and s != "0" and s != "Reduction curves":
            last = s
        if s == "Reduction curves":
            last = ""
        sectors.append(last)
    years = [(i, int(cell(rows, i, 0))) for i in range(first, len(rows)) if cell(rows, i, 0).isdigit()]

    columns = []
    for c in range(1, ncols):
        label = cell(rows, label_row, c)
        if not label or not sectors[c]:
            continue
        unit = cell(rows, unit_row, c)
        values = {y: cell(rows, i, c) for i, y in years}
        columns.append({"c": c, "sector": sectors[c], "label": label, "unit": unit, "values": values})

    out: list[dict] = []
    for idx, col in enumerate(columns):
        inherited_from = None
        values = col["values"]
        unit = col["unit"]
        if layout == "ec" and not any(v for v in values.values()):
            # Merged cell in the proforma: the sector-level limit applies.
            for prev in reversed(columns[:idx]):
                if prev["sector"] == col["sector"] and any(v for v in prev["values"].values()):
                    inherited_from = prev
                    break
            if inherited_from is None:
                raise SystemExit(f"{table}: column {col['label']} is blank and has nothing to inherit")
            values = inherited_from["values"]
            unit = unit or inherited_from["unit"]
        subsector, scope = split_label(col["label"], col["sector"])
        if inherited_from is not None and table == "EC-3":
            # Reportable Works limits are set per fit-out category, so an
            # inherited Storage column takes the category of the column it
            # inherits from, not the "Whole building" wording of its own label.
            scope = split_label(inherited_from["label"], inherited_from["sector"])[1] or scope
        for year, raw in values.items():
            status, value, note = classify(raw, unit)
            row_unit = unit
            if status == "limit" and unit.lower() == "n/a":
                # Healthcare columns carry "n/a" in the unit row because new
                # buildings defer to the NHS standard, but the existing-building
                # tables publish numeric EUI limits for them (Table 10).
                row_unit = "kWh/m2GIA/yr"
                note = "Unit taken from Table 10; the unit row in the published table reads n/a."
            if status == "no_limit" and table == "EC-3":
                note = "Table EC-3: to be confirmed once sufficient data is lodged via the Standard."
            if inherited_from is not None:
                note = (note + " " if note else "") + f"Sector-level limit; merged cell in the published table (same column as {inherited_from['label']})."
            out.append({
                "table": table, "aspect": aspect, "sector": col["sector"], "subsector": subsector, "scope": scope,
                "label": col["label"], "area_basis": area_basis(row_unit), "year": year, "value": value or "",
                "unit": "" if row_unit.lower() == "n/a" else row_unit, "status": status, "note": note,
            })
    return out


def area_basis(unit: str) -> str:
    u = unit.lower()
    if "nia" in u:
        return "NIA"
    if "gia" in u:
        return "GIA"
    if u == "pue":
        return "PUE"
    return ""


def convert_nia(rows: list[list[str]]) -> list[dict]:
    """Offices NIA alternatives. The group header row only labels the first
    column of each block; blocks are nine columns wide."""
    if not cell(rows, 1, 0).lower().startswith("date of commencement"):
        raise SystemExit("NIA: unexpected header layout")
    ncols = max(len(r) for r in rows)
    years = [(i, int(cell(rows, i, 0))) for i in range(3, len(rows)) if cell(rows, i, 0).isdigit()]
    out: list[dict] = []
    table = None
    for c in range(1, ncols):
        group = cell(rows, 0, c)
        if group in NIA_GROUPS:
            table = NIA_GROUPS[group]
        label = cell(rows, 1, c)
        if not label or table is None:
            continue
        values = {y: cell(rows, i, c) for i, y in years}
        if not any(values.values()):
            continue
        subsector, scope = split_label(label, "Offices")
        for year, raw in values.items():
            status, value, note = classify(raw, "kWh/m2NIA/yr")
            out.append({
                "table": table, "aspect": "operational_energy", "sector": "Offices", "subsector": subsector, "scope": scope,
                "label": label, "area_basis": "NIA", "year": year, "value": value or "", "unit": "kWh/m2NIA/yr", "status": status,
                "note": (note + " " if note else "") + "NIA alternative to the GIA limit (Table 10: Offices may use either).",
            })
    return out


def convert_reduction_curves(rows: list[list[str]]) -> list[dict]:
    ncols = max(len(r) for r in rows)
    start = next((c for c in range(ncols) if cell(rows, 1, c) == "Reduction curves"), None)
    if start is None:
        return []
    out = []
    for i in range(4, len(rows)):
        y = cell(rows, i, start)
        if y.isdigit():
            out.append({"year": int(y), "residential": cell(rows, i, start + 1), "non_residential": cell(rows, i, start + 2)})
    return out


def convert_renewables(rows: list[list[str]]) -> tuple[list[dict], list[dict]]:
    targets, other = [], []
    regions = {"Scotland": "A. Scotland", "South England": "C. South England", "Everywhere Else in UK": "B. Middle and North England, Northern Ireland, Wales"}
    for r in rows:
        r = [squash(c) for c in r] + [""] * 8
        if r[1] in regions:
            targets.append({"region": regions[r[1]], "building_group": "all_other", "value": r[2], "unit": "kWh/m2FP/yr"})
            targets.append({"region": regions[r[1]], "building_group": "single_family_homes_or_single_storey_storage", "value": r[3], "unit": "kWh/m2FP/yr"})
        elif r[1].startswith("Photovoltaics"):
            other.append({"key": "pv_upfront_carbon_proforma", "value": r[2], "unit": "kgCO2e/kWp", "source": "Proforma rev03, Other limits sheet",
                          "note": "The Rev 1 text (Annex A Table EC-5) prints 1000 kgCO2e/kWp. The engine uses the Standard's value; this row records the proforma figure for the verification log."})
        elif r[1].startswith("Refrigerant"):
            other.append({"key": "refrigerant_gwp_limit", "value": r[2], "unit": "kgCO2e/kg", "source": "Annex A4; proforma rev03 Other limits sheet", "note": "Corresponds to R-32 in the 2025 UK Government conversion factors."})
    other.insert(0, {"key": "pv_upfront_carbon", "value": "1000", "unit": "kgCO2e/kWp", "source": "Annex A Table EC-5 (Rev 1 text)",
                     "note": "Photovoltaics only; wind and hydro are reporting only. See pv_upfront_carbon_proforma for the differing proforma figure."})
    return targets, other


def convert_menus(rows: list[list[str]]) -> list[dict]:
    header = [squash(c) for c in rows[0]]
    out = []
    for c, name in enumerate(header):
        if not name:
            continue
        pos = 0
        for r in rows[1:]:
            v = squash(r[c]) if c < len(r) else ""
            if v:
                pos += 1
                out.append({"menu": name, "position": pos, "value": v})
    return out


def write_csv(path: str, rows: list[dict], fields: list[str]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fields})


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)

    limits: list[dict] = []
    for table, aspect, fname, layout in TABLES:
        limits.extend(convert_table(table, aspect, read(os.path.join(src, fname)), layout))
    limits.extend(convert_nia(read(os.path.join(src, "energy_use_nia.csv"))))
    curves = convert_reduction_curves(read(os.path.join(src, "embodied_carbon_new_works.csv")))
    targets, other = convert_renewables(read(os.path.join(src, "other_limits.csv")))
    menus = convert_menus(read(os.path.join(src, "menus.csv")))

    files = {
        "limits.csv": (limits, ["table", "aspect", "sector", "subsector", "scope", "label", "area_basis", "year", "value", "unit", "status", "note"]),
        "renewables_targets.csv": (targets, ["region", "building_group", "value", "unit"]),
        "other_limits.csv": (other, ["key", "value", "unit", "source", "note"]),
        "reduction_curves.csv": (curves, ["year", "residential", "non_residential"]),
        "menus.csv": (menus, ["menu", "position", "value"]),
    }
    for name, (rows, fields) in files.items():
        write_csv(os.path.join(out, name), rows, fields)

    manifest = {
        "version": os.path.basename(os.path.normpath(out)),
        "standard": "UK Net Zero Carbon Buildings Standard, Version 1, Rev 1 (April 2026)",
        "proforma": "Submission Proforma v1 rev03 (April 2026)",
        "publisher": "Net Zero Carbon Buildings Standard Ltd, https://www.nzcbuildings.co.uk/",
        "converted_on": date.today().isoformat(),
        "converter": "scripts/nzcbs/convert-proforma-tables.py",
        "files": {name: {"sha256": sha256(os.path.join(out, name)), "rows": len(rows)} for name, (rows, _) in files.items()},
    }
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    for name, (rows, _) in files.items():
        print(f"{name}: {len(rows)} rows")


if __name__ == "__main__":
    main()
