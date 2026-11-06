"""Pre-verification comparison of supplied building values with the UK NZCBS V1
Rev 1 limits the Standard selects for that building.

Mirrors the limit selection of the portal's engine (``src/lib/nzcbs/limits.ts``)
for a single-sector building: table by building type and route (5.2.7.1),
embodied table by works type (5.1.6), the Annex A3 renewables target by region
and group, the A4 GWP limit, the EC-5 PV limit and the OE-4 space heating limit.
The caller supplies the measured or assessed values; this layer has no meters.

The governing rule is unchanged:

    No limit, benchmark or asset value is invented.

Where the Standard sets no limit, no value was supplied, or the query is
ambiguous, the row is ``not_assessable`` with the reason -- never a pass.
"""

from __future__ import annotations

import re
from typing import Any

from ..nzcbs import DISCLAIMER, PRE_VERIFICATION_STATEMENT, Reference, find_limit, operational_table, other_limit, renewables_target

NOT_ASSESSABLE_NOTE = "Metrics with no limit in the Standard, no supplied value, or an ambiguous selection are reported as not assessable, never as a pass."

# Metric keys the check understands, with the aliases callers tend to use.
METRICS: dict[str, tuple[str, ...]] = {
    "eui": ("eui", "operational_energy_eui", "energy_use_intensity", "operational_energy"),
    "pue": ("pue", "power_usage_effectiveness"),
    "upfront_carbon": ("upfront_carbon", "embodied_upfront", "upfront_embodied_carbon", "embodied_carbon"),
    "space_heating": ("space_heating", "space_heating_demand", "space_heating_delivered"),
    "renewables_per_footprint": ("renewables_per_footprint", "onsite_renewables", "onsite_renewable_generation"),
    "refrigerant_gwp": ("refrigerant_gwp", "gwp"),
    "pv_upfront_carbon_per_kwp": ("pv_upfront_carbon_per_kwp", "pv_upfront_carbon"),
}


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def _canonical(key: str) -> str | None:
    n = _norm(key)
    for canonical, aliases in METRICS.items():
        if n in aliases:
            return canonical
    return None


def _row(metric: str, section: str, *, value: float | None, limit: float | None, unit: str, status: str, reason: str, table: str | None = None, year: int | None = None) -> dict[str, Any]:
    gap = round(value - limit, 3) if (status in ("pass", "fail") and value is not None and limit is not None) else None
    return {"metric": metric, "section": section, "table": table, "year": year, "limit_value": limit, "unit": unit, "asset_value": value, "status": status, "label": {"pass": "within limit", "fail": "above limit"}.get(status, status.replace("_", " ")), "gap": gap, "reason": reason}


def _compare(metric: str, section: str, value: float | None, res, *, higher_is_better: bool = False, missing_value: str) -> dict[str, Any]:
    if res.status != "limit" or res.value is None:
        reason = " ".join(res.notes) or {"no_limit": "The Standard sets no limit here.", "not_applicable": "Not applicable to this sector.", "deferred": "Deferred to another standard."}.get(res.status, "No limit could be selected.")
        return _row(metric, section, value=value, limit=None, unit=res.unit, status="not_assessable", reason=reason, table=res.row.table if res.row else None, year=res.year)
    if value is None:
        return _row(metric, section, value=None, limit=res.value, unit=res.unit, status="not_assessable", reason=missing_value, table=res.row.table if res.row else None, year=res.year)
    ok = value >= res.value if higher_is_better else value <= res.value
    reason = f"Supplied value {value} against the limit {res.value} {res.unit} (Table {res.row.table if res.row else ''} {res.year}). " + " ".join(res.notes)
    return _row(metric, section, value=value, limit=res.value, unit=res.unit, status="pass" if ok else "fail", reason=reason.strip(), table=res.row.table if res.row else None, year=res.year)


def check(
    ref: Reference | None,
    *,
    sector: str,
    year: int,
    asset_values: dict[str, float],
    building_type: str = "Existing Building",
    route: str = "one-go",
    subsector: str | None = None,
    scope: str | None = None,
    area_basis: str | None = None,
    works_type: str | None = None,
    region: str | None = None,
    single_family_home_or_single_storey_storage: bool = False,
    loaded_versions: list[str],
    requested_version: str | None,
    deployment_dir: str,
    bundled_dir: str,
) -> dict[str, Any]:
    base: dict[str, Any] = {
        "year": year, "sector": sector, "subsector": subsector, "scope": scope, "building_type": building_type, "route": route,
        "version": ref.version if ref else None, "file": ref.file_name if ref else None, "rows": [],
        "counts": {"pass": 0, "fail": 0, "not_assessable": 0}, "disclaimer": DISCLAIMER,
        "permitted_statement": PRE_VERIFICATION_STATEMENT, "warnings": [],
    }
    if ref is None:
        loaded = ", ".join(loaded_versions) or "none"
        reason = (
            f"UK NZCBS reference version {requested_version} is not loaded (loaded: {loaded}). Supply it as a folder under {deployment_dir}."
            if requested_version
            else f"No UK NZCBS reference tables are loaded: neither {bundled_dir} nor {deployment_dir} holds a version folder."
        )
        return {**base, "assessable": False, "summary": "Cannot check against the UK NZCBS: no reference tables loaded.", "reasons": [reason]}
    if not sector.strip():
        return {**base, "assessable": False, "summary": "Cannot check against the UK NZCBS: no sector.", "reasons": [f"Give a Table 6 sector. Sectors: {', '.join(ref.sectors)}."]}
    matched = next((s for s in ref.sectors if s.lower() == sector.strip().lower()), None)
    if matched is None:
        return {**base, "assessable": False, "summary": f'Cannot check against the UK NZCBS: "{sector}" is not a Table 6 sector.', "reasons": [f"Sectors: {', '.join(ref.sectors)}."]}
    base["sector"] = matched

    supplied: dict[str, float] = {}
    unknown: list[str] = []
    for k, v in (asset_values or {}).items():
        c = _canonical(k)
        if c is None:
            unknown.append(k)
        else:
            supplied[c] = float(v)

    rows: list[dict[str, Any]] = []
    table = operational_table(building_type, route)
    eui_res = find_limit(ref, table=table, sector=matched, year=year, subsector=subsector, scope=scope, area_basis=area_basis or ("GIA" if matched == "Offices" else None))
    rows.append(_compare("Energy use intensity", "5.2.7.1", supplied.get("eui"), eui_res, missing_value="No EUI was supplied: all in-scope energy including on-site renewables used on site, over GIA (or NIA for Offices), kWh/m2/yr."))

    if matched == "Data Centres" or "pue" in supplied:
        pue_res = find_limit(ref, table=table, sector="Data Centres", year=year, subsector=subsector)
        rows.append(_compare("Power Usage Effectiveness", "5.2.7.1", supplied.get("pue"), pue_res, missing_value="No PUE was supplied (total Data Centre energy over IT energy)."))

    if works_type or "upfront_carbon" in supplied:
        ec_table = {"New Works": "EC-1", "Retrofit Works": "EC-2", "Reportable Works": "EC-3"}.get(works_type or "")
        if ec_table is None:
            rows.append(_row("Upfront carbon", "5.1.6", value=supplied.get("upfront_carbon"), limit=None, unit="kgCO2e/m2GIA", status="not_assessable", reason="Give works_type as New Works, Retrofit Works or Reportable Works to select Table EC-1, EC-2 or EC-3 (5.1.6). Non-Reportable Works have no embodied carbon limit."))
        else:
            ec_res = find_limit(ref, table=ec_table, sector=matched, year=year, subsector=subsector, scope=scope)
            rows.append(_compare(f"Upfront carbon ({works_type})", "5.1.6.1" if ec_table != "EC-3" else "5.1.6.2", supplied.get("upfront_carbon"), ec_res, missing_value="No upfront carbon figure was supplied (kgCO2e/m2GIA from a RICS PS assessment)."))

    if building_type == "New Building" and (matched in ("Homes", "Commercial Residential") or "space_heating" in supplied):
        sh_res = find_limit(ref, table="OE-4", sector=matched, year=year, subsector=subsector)
        rows.append(_compare("Annual space heating delivered to the building", "5.8.5.2", supplied.get("space_heating"), sh_res, missing_value="No delivered space heating figure was supplied (kWh/m2GIA/yr over occupied GIA)."))
    elif "space_heating" in supplied:
        rows.append(_row("Annual space heating delivered to the building", "5.8.5.1", value=supplied["space_heating"], limit=None, unit="kWh/m2GIA/yr", status="not_assessable", reason="Space heating limits apply to New Buildings only in this version; the figure is a reporting metric here."))

    if region or "renewables_per_footprint" in supplied:
        if not region:
            rows.append(_row("Annual on-site renewable electricity generation per m2 footprint", "5.3.5.1", value=supplied.get("renewables_per_footprint"), limit=None, unit="kWh/m2FP/yr", status="not_assessable", reason="Give region as one of the Annex A3 regions to select the target."))
        else:
            group = "single_family_homes_or_single_storey_storage" if single_family_home_or_single_storey_storage else "all_other"
            t = renewables_target(ref, region, group)
            if t is None:
                rows.append(_row("Annual on-site renewable electricity generation per m2 footprint", "5.3.5.1", value=supplied.get("renewables_per_footprint"), limit=None, unit="kWh/m2FP/yr", status="not_assessable", reason=f'No Annex A3 target for region "{region}". Regions: {", ".join(sorted({x.region for x in ref.renewables_targets}))}.'))
            else:
                v = supplied.get("renewables_per_footprint")
                if v is None:
                    rows.append(_row("Annual on-site renewable electricity generation per m2 footprint", "5.3.5.1", value=None, limit=t.value, unit=t.unit, status="not_assessable", reason="No generation per m2 footprint was supplied. The target may be reduced under 5.3.5.1 (Equation 5, reused systems, kWp floors); the full target is shown."))
                else:
                    rows.append(_row("Annual on-site renewable electricity generation per m2 footprint", "5.3.5.1", value=v, limit=t.value, unit=t.unit, status="pass" if v >= t.value else "fail", reason=f"Supplied {v} against the Annex A3 target {t.value} {t.unit} for {region} ({'Single Family Homes and single-storey Storage and Distribution' if group != 'all_other' else 'all other building types'}), before any 5.3.5.1 reduction. A target is a minimum."))

    if "refrigerant_gwp" in supplied:
        gwp = other_limit(ref, "refrigerant_gwp_limit")
        v = supplied["refrigerant_gwp"]
        rows.append(_row("GWP of refrigerant", "5.9.6", value=v, limit=gwp.value if gwp else None, unit=gwp.unit if gwp else "kgCO2e/kg", status=("pass" if v <= gwp.value else "fail") if gwp and gwp.value is not None else "not_assessable", reason=(f"Supplied GWP {v} against the Annex A4 limit {gwp.value} {gwp.unit}; the 5.9.6 exceptions (cannot retrofit; installed before Version 1 with an RPEP before 2030) are not applied here." if gwp else "No GWP limit loaded.")))

    if "pv_upfront_carbon_per_kwp" in supplied:
        pv = other_limit(ref, "pv_upfront_carbon")
        pro = other_limit(ref, "pv_upfront_carbon_proforma")
        v = supplied["pv_upfront_carbon_per_kwp"]
        note = f" The proforma prints {pro.value} {pro.unit}; the Standard's text prints {pv.value}; the text is used." if pv and pro and pro.value != pv.value else ""
        rows.append(_row("PV upfront carbon per kWp", "5.1.6.4", value=v, limit=pv.value if pv else None, unit=pv.unit if pv else "kgCO2e/kWp", status=("pass" if v <= pv.value else "fail") if pv and pv.value is not None else "not_assessable", reason=(f"Supplied {v} against the Table EC-5 limit {pv.value} {pv.unit}.{note}" if pv else "No PV limit loaded.")))

    for k in unknown:
        rows.append(_row(k, "", value=asset_values[k], limit=None, unit="", status="not_assessable", reason=f'Unknown metric "{k}". Known metrics: {", ".join(METRICS)}.'))

    counts = {
        "pass": sum(1 for r in rows if r["status"] == "pass"),
        "fail": sum(1 for r in rows if r["status"] == "fail"),
        "not_assessable": sum(1 for r in rows if r["status"] == "not_assessable"),
    }
    eui = rows[0]
    summary = (
        f"Pre-verification check against UK NZCBS {ref.version} for {matched}{f' / {subsector}' if subsector else ''} as "
        f"{building_type}{'' if building_type == 'New Building' else f' ({route} route)'}, Table {table} for {eui_res.year}: "
        f"{counts['pass']} within limit, {counts['fail']} above limit, {counts['not_assessable']} not assessable"
    )
    if eui["status"] in ("pass", "fail"):
        summary += f". Energy use intensity: {eui['asset_value']} against {eui['limit_value']} {eui['unit']} ({eui['label']} by {abs(eui['gap'])} {eui['unit']})"
    summary += f". Not a verified claim: the building is {PRE_VERIFICATION_STATEMENT}."
    warnings = [DISCLAIMER]
    if counts["not_assessable"]:
        warnings.append(NOT_ASSESSABLE_NOTE)
    if building_type == "Existing Building" and route == "stepped":
        warnings.append("The stepped route requires a PAS 2035 or PAS 2038 Retrofit Plan (5.2.8) and its limits fall in later assessments.")
    return {**base, "assessable": True, "summary": summary, "reasons": [], "rows": rows, "counts": counts, "table": table, "limit_year": eui_res.year, "warnings": warnings}
