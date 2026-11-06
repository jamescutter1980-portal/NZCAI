"""Limit selection: which Annex A table, which year, and how the sector and
area weighting of 4.2.5.2 combine the published figures into the one limit this
building is compared with. Mirrors the portal engine's limits module.
"""

from __future__ import annotations

from typing import Any

from .classify import allowed_additional_use, classify_building, classify_sectors, limit_sector_for, reporting_periods, works_type
from .constants import (
    EQUATION_1B_MAX_NEW_SHARE,
    EQUATION_1B_MIN_NEW_SHARE,
    RENEWABLES_MIN_CAPACITY_KWP_OTHER,
    RENEWABLES_MIN_CAPACITY_KWP_SINGLE_FAMILY,
    REPORTABLE_CAT_B_SHARE,
    REUSED_SYSTEM_TARGET_REDUCTION,
    VERSION_1_PUBLICATION_DATE,
)
from .reference import LIMIT_TABLE_FIRST_YEAR, Reference, find_limit, operational_table, other_limit, renewables_target


def _r(x: float, dp: int = 3) -> float:
    return round(x + 0.0, dp)


def _year(iso: str) -> int:
    return int(iso[:4])


def _latest(works: list[dict[str, Any]], wtype: str) -> dict[str, Any] | None:
    matching = [w for w in works if works_type(w)["value"] == wtype]
    matching.sort(key=lambda w: w["commencementDate"], reverse=True)
    return matching[0] if matching else None


# --------------------------------------------------------------------------- #
# years                                                                        #
# --------------------------------------------------------------------------- #


def operational_limit_year(profile: dict[str, Any], building_type: str, periods: dict[str, Any]) -> dict[str, Any]:
    """5.2.7.1 limit dates."""
    works = profile.get("works") or []
    if building_type == "New Building":
        nw = _latest(works, "New Works")
        if nw:
            return {"year": max(LIMIT_TABLE_FIRST_YEAR, _year(nw["commencementDate"])), "section": "5.2.7.1", "rule": f"New Building: Date of Commencement of the New Works ({nw['commencementDate']}), or 2025 if more recent."}
        return {"year": LIMIT_TABLE_FIRST_YEAR, "section": "5.2.7.1", "rule": "New Building with no New Works commencement date recorded: 2025 is used. Record the commencement date to set the year correctly."}
    route = profile.get("operationalRoute") or "one-go"
    if route == "stepped":
        return {"year": periods["orpStartYear"], "section": "5.2.7.1", "rule": f"Existing Building, stepped route: the year the ORP starts ({periods['orp']['from']}). A Retrofit Plan is required (5.2.8)."}
    rw = _latest(works, "Retrofit Works")
    if rw and _year(rw["commencementDate"]) >= LIMIT_TABLE_FIRST_YEAR:
        return {"year": _year(rw["commencementDate"]), "section": "5.2.7.1", "rule": f"Existing Building, one-go route: Date of Commencement of the most recent Retrofit Works ({rw['commencementDate']})."}
    return {"year": LIMIT_TABLE_FIRST_YEAR, "section": "5.2.7.1", "rule": "Existing Building, one-go route: no Retrofit Works have commenced since 2025, so 2025 is used."}


# --------------------------------------------------------------------------- #
# Equations 1a and 1b                                                          #
# --------------------------------------------------------------------------- #


def _areas_for_operational_limit(profile: dict[str, Any], classification: dict[str, Any], notes: list[str]) -> list[dict[str, Any]]:
    omitted = {e["sector"] for e in classification["omitted"]}
    out = []
    for area in profile.get("areas") or []:
        if area.get("sector") is None:
            continue
        if area["sector"] in omitted and not area.get("particularUse"):
            continue
        if allowed_additional_use(classification, area) and not area.get("outOfHoursUse"):
            notes.append(f"{area['additionalUse']} ({area.get('niaM2')} m2 NIA) is an Additional Use and is left out of the limit calculation (5.2.7.1).")
            continue
        if area.get("carPark"):
            notes.append(f"Car park ({area.get('niaM2')} m2) is left out of the limit calculation (5.2.7.1).")
            continue
        target = limit_sector_for(area)
        if target is None:
            continue
        if target["sector"] == "Data Centres":
            notes.append(f"Data Centre area ({area.get('niaM2')} m2) is assessed on PUE and ignored by Equation 1a (5.2.7.1).")
            continue
        out.append({"area": area, **target})
    return out


def _weighted(ref: Reference, table: str, year: int, areas: list[dict[str, Any]], basis: str | None, weight_by: str) -> dict[str, Any]:
    notes: list[str] = []
    components = []
    for a in areas:
        area_basis = basis if (basis and a["sector"] == "Offices") else None
        res = find_limit(ref, table=table, sector=a["sector"], year=year, subsector=a.get("subsector"), scope=a.get("scope"), area_basis=area_basis)
        gia = a["area"].get("giaM2")
        weight = float(gia if (weight_by == "gia" and gia is not None) else a["area"].get("niaM2") or 0)
        if weight_by == "gia" and gia is None:
            notes.append(f"{a['sector']} {a.get('subsector') or ''}: no GIA recorded for the area, so its NIA is used as the Equation 1b weight.")
        components.append({"sector": a["sector"], "subsector": a.get("subsector"), "scope": a.get("scope"), "niaM2": weight, "share": 0.0, "resolution": res})
    usable = [c for c in components if c["resolution"].status == "limit" and c["resolution"].value is not None]
    dropped = [c for c in components if c["resolution"].status != "limit"]
    for d in dropped:
        st = d["resolution"].status
        why = "no limit in the table, so the area is omitted from the weighting (4.2.5.2)" if st in ("no_limit", "not_applicable", "deferred") else " ".join(d["resolution"].notes)
        notes.append(f"{d['sector']}{' / ' + d['subsector'] if d.get('subsector') else ''}: {why}.")
    blocking = [d for d in dropped if d["resolution"].status in ("not_found", "ambiguous", "unavailable")]
    out = {"table": table, "year": year, "components": [{**c, "resolution": c["resolution"].as_dict()} for c in components], "notes": notes, "areaBasis": basis or "GIA"}
    if not usable:
        return {**out, "status": "not_assessable" if blocking else "no_limit", "value": None, "unit": components[0]["resolution"].unit if components else "", "method": "none"}
    if blocking:
        return {**out, "status": "not_assessable", "value": None, "unit": usable[0]["resolution"].unit, "method": "none", "notes": notes + ["A limit could not be resolved for every area with a limit, so no weighted limit is given."]}
    units = {u["resolution"].unit for u in usable}
    if len(units) > 1:
        return {**out, "status": "not_assessable", "value": None, "unit": " | ".join(sorted(units)), "method": "none", "areaBasis": "", "notes": notes + [f"The areas resolve to limits in different units ({', '.join(sorted(units))}); choose one area basis (Table 10)."]}
    total = sum(c["niaM2"] for c in usable)
    value = 0.0
    for c in usable:
        c["share"] = round(c["niaM2"] / total, 6) if total > 0 else 0.0
        value += c["share"] * c["resolution"].value
    unit = usable[0]["resolution"].unit
    area_basis = "NIA" if "nia" in unit.lower() else "GIA" if "gia" in unit.lower() else ""
    out["components"] = [{**c, "resolution": c["resolution"].as_dict()} for c in components]
    if len(usable) == 1 and usable[0]["share"] == 1:
        return {**out, "status": "limit", "value": _r(value), "unit": unit, "areaBasis": area_basis, "method": "single", "notes": notes + usable[0]["resolution"].notes}
    working = " + ".join(f"{round(c['share'] * 1000) / 10}% x {c['resolution'].value} ({c['sector']}{' ' + c['subsector'] if c.get('subsector') else ''})" for c in usable)
    return {**out, "status": "limit", "value": _r(value), "unit": unit, "areaBasis": area_basis, "method": "equation_1a", "notes": notes + [f"Equation 1a: {working} = {_r(value)} {unit}."]}


def operational_energy_limit(ref: Reference, profile: dict[str, Any], classification: dict[str, Any], building_type: str, limit_year: dict[str, Any]) -> dict[str, Any]:
    """5.2.7.1 with 4.2.5.2; Equation 1b where 10% to 50% of NIA is New Area."""
    notes: list[str] = []
    areas = _areas_for_operational_limit(profile, classification, notes)
    if not areas:
        return {"status": "not_assessable", "value": None, "unit": "", "areaBasis": "", "table": None, "year": limit_year["year"], "method": "none", "components": [], "notes": notes + ["No floor area that takes an operational energy limit was supplied."]}
    basis = profile.get("areaBasis")
    table = operational_table(building_type, profile.get("operationalRoute") or "one-go")
    nia = classification["totalNiaM2"]
    new_share = sum(float(a.get("niaM2") or 0) for a in profile.get("areas") or [] if a.get("newArea")) / nia if nia > 0 else 0.0
    if building_type == "Existing Building" and EQUATION_1B_MIN_NEW_SHARE <= new_share < EQUATION_1B_MAX_NEW_SHARE:
        new_areas = [a for a in areas if a["area"].get("newArea")]
        existing = [a for a in areas if not a["area"].get("newArea")]
        nw = _latest(profile.get("works") or [], "New Works")
        new_year = max(LIMIT_TABLE_FIRST_YEAR, _year(nw["commencementDate"])) if nw else limit_year["year"]
        ln = _weighted(ref, "OE-1", new_year, new_areas, basis, "gia")
        le = _weighted(ref, table, limit_year["year"], existing, basis, "gia")
        all_notes = [f"New Areas: {n}" for n in ln["notes"]] + [f"Existing Areas: {n}" for n in le["notes"]]
        components = ln["components"] + le["components"]
        if ln["status"] != "limit" or le["status"] != "limit" or ln["unit"] != le["unit"]:
            return {"status": "not_assessable", "value": None, "unit": ln["unit"] or le["unit"], "areaBasis": "", "table": table, "year": limit_year["year"], "method": "equation_1b", "components": components, "notes": notes + all_notes + ["Equation 1b needs a limit for both the New Areas and the Existing Areas."]}
        gia_new = sum(float(a["area"].get("giaM2") if a["area"].get("giaM2") is not None else a["area"].get("niaM2") or 0) for a in new_areas)
        gia_existing = sum(float(a["area"].get("giaM2") if a["area"].get("giaM2") is not None else a["area"].get("niaM2") or 0) for a in existing)
        p_n = gia_new / (gia_new + gia_existing)
        p_e = 1 - p_n
        value = _r(p_n * ln["value"] + p_e * le["value"] + p_n * (ln["value"] - le["value"]))
        notes.append(f"Equation 1b: {round(p_n * 1000) / 10}% New Area x {ln['value']} + {round(p_e * 1000) / 10}% Existing Area x {le['value']} + {round(p_n * 1000) / 10}% x ({ln['value']} - {le['value']}) = {value} {ln['unit']} (4.2.5.2). New Areas use Table OE-1 for {new_year}; Existing Areas use Table {table} for {limit_year['year']}.")
        return {"status": "limit", "value": value, "unit": ln["unit"], "areaBasis": ln["areaBasis"], "table": table, "year": limit_year["year"], "method": "equation_1b", "components": components, "notes": notes + all_notes}
    result = _weighted(ref, table, limit_year["year"], areas, basis, "nia")
    return {**result, "notes": notes + result["notes"]}


# --------------------------------------------------------------------------- #
# embodied carbon, space heating, renewables                                   #
# --------------------------------------------------------------------------- #


def embodied_carbon_limit(ref: Reference, profile: dict[str, Any], classification: dict[str, Any], works: dict[str, Any]) -> dict[str, Any]:
    """5.1.6: the upfront carbon limit for one programme of works."""
    wtype = works_type(works)["value"]
    year = _year(works["commencementDate"])
    compare = works["commencementDate"] >= VERSION_1_PUBLICATION_DATE
    notes = [] if compare else [f"Works commenced {works['commencementDate']}, before Version 1 of the Standard; the assessment is reported but not compared with a limit (5.1.6)."]
    base = {"worksId": works.get("id"), "worksType": wtype, "compare": compare, "year": year, "areaBasis": "GIA", "reportableScope": None}
    if wtype == "Non-Reportable Works":
        return {**base, "status": "no_limit", "value": None, "unit": "", "table": None, "method": "none", "components": [], "notes": notes + ["Non-Reportable Works are outside the embodied carbon scope (5.1.2.1)."]}
    table = {"New Works": "EC-1", "Retrofit Works": "EC-2"}.get(wtype, "EC-3")
    embodied = works.get("embodied") or {}
    scope = embodied.get("scope")
    reportable_scope = None
    if table == "EC-3":
        cat_b, total = embodied.get("upfrontCatBKgCo2e"), embodied.get("upfrontKgCo2e")
        if cat_b is not None and total and cat_b / total > REPORTABLE_CAT_B_SHARE:
            reportable_scope = "Cat B"
            notes.append(f"Cat B works are {round(cat_b / total * 100)}% of the upfront carbon, above 80%, so the Cat B limit applies and Shell and Core and Cat A are excluded from the compared scope (5.1.6.2).")
        else:
            reportable_scope = "Cat A + Cat B"
            notes.append("The Cat A + Cat B limit applies (5.1.6.2).")
        scope = reportable_scope
    omitted = {e["sector"] for e in classification["omitted"]}
    areas = [{"area": a, "sector": a["sector"], "subsector": a.get("subsector"), "scope": scope or a.get("scope")} for a in profile.get("areas") or [] if a.get("sector") is not None and a["sector"] not in omitted]
    if not areas:
        return {**base, "status": "not_assessable", "value": None, "unit": "", "table": table, "method": "none", "components": [], "notes": notes + ["No classified floor area was supplied, so no embodied carbon limit can be selected."], "reportableScope": reportable_scope}
    w = _weighted(ref, table, year, areas, None, "nia")
    return {**base, **w, "notes": notes + w["notes"], "reportableScope": reportable_scope}


def pv_upfront_limit(ref: Reference) -> dict[str, Any]:
    """Table EC-5, with the proforma discrepancy carried as a note."""
    standard = other_limit(ref, "pv_upfront_carbon")
    proforma = other_limit(ref, "pv_upfront_carbon_proforma")
    notes = [standard.note] if standard and standard.note else []
    if standard and proforma and proforma.value != standard.value:
        notes.append(f"The submission proforma prints {proforma.value} {proforma.unit}; the Standard's text prints {standard.value} {standard.unit}. The Standard's figure is used; confirm with NZCBS Ltd before a submission relies on the margin between them.")
    return {"value": standard.value if standard else None, "unit": standard.unit if standard else "kgCO2e/kWp", "notes": notes}


def space_heating_limit(ref: Reference, profile: dict[str, Any], classification: dict[str, Any], building_type: str) -> dict[str, Any]:
    """Table OE-4: New Buildings, Homes and Commercial Residential only (5.8.5)."""
    empty = {"value": None, "unit": "kWh/m2GIA/yr", "areaBasis": "GIA", "table": "OE-4", "method": "none", "components": []}
    if building_type != "New Building":
        return {**empty, "status": "no_limit", "year": LIMIT_TABLE_FIRST_YEAR, "notes": ["Space heating limits apply to New Buildings only in this version (5.8.5.1)."]}
    nw = _latest(profile.get("works") or [], "New Works")
    year = max(LIMIT_TABLE_FIRST_YEAR, _year(nw["commencementDate"])) if nw else LIMIT_TABLE_FIRST_YEAR
    omitted = {e["sector"] for e in classification["omitted"]}
    areas = [{"area": a, "sector": a["sector"], "subsector": a.get("subsector"), "scope": None} for a in profile.get("areas") or [] if a.get("sector") in ("Homes", "Commercial Residential") and a["sector"] not in omitted]
    if not areas:
        return {**empty, "status": "no_limit", "year": year, "notes": ["No Homes or Commercial Residential floor area, so no space heating limit applies; delivered heating and cooling are still reported (5.8.5.1)."]}
    w = _weighted(ref, "OE-4", year, areas, None, "nia")
    return {**w, "notes": w["notes"] + ["Areas of sectors without a heating limit are excluded and must be submetered (5.8.3, 5.8.5.1)."]}


def renewables_target_for(ref: Reference, profile: dict[str, Any], classification: dict[str, Any], inp: dict[str, Any] | None, operational_limit: dict[str, Any] | None) -> dict[str, Any]:
    """Annex A3 with the 5.3.5.1 reductions."""
    notes: list[str] = []
    steps: list[str] = []
    region = profile.get("region")
    if not region:
        return {"baseTarget": None, "target": None, "unit": "kWh/m2FP/yr", "group": None, "applies": True, "steps": steps, "notes": ["No Annex A3 region recorded for the building, so no target can be selected."]}
    sectors = classification["sectors"]
    single_family = classification["classification"] == "Homes" and sectors and all((p.get("subsector") or "").lower().startswith("single family") for p in sectors[0]["parts"])
    single_storey_storage = classification["classification"] == "Storage and Distribution" and bool(profile.get("singleStorey"))
    group = "single_family_homes_or_single_storey_storage" if (single_family or single_storey_storage) else "all_other"
    row = renewables_target(ref, region, group)
    if row is None:
        return {"baseTarget": None, "target": None, "unit": "kWh/m2FP/yr", "group": group, "applies": True, "steps": steps, "notes": [f"No Annex A3 target loaded for {region} / {group}."]}
    target = row.value
    steps.append(f"Annex A3 target for {region}, {'all other building types' if group == 'all_other' else 'Single Family Homes and single-storey Storage and Distribution'}: {row.value} {row.unit}.")
    footprint = profile.get("footprintM2")
    inp = inp or {}
    constraints = inp.get("constraints")
    if constraints and constraints.get("reasons"):
        if not footprint or footprint <= 0:
            notes.append("Equation 5 needs the building footprint; the constraint reduction was not applied.")
        else:
            ratio = min(1.0, float(constraints["unconstrainedAreaM2"]) / float(footprint))
            target = _r(target * ratio)
            steps.append(f"Equation 5: {row.value} x min(1, {constraints['unconstrainedAreaM2']} / {footprint}) = {target} (constraints: {', '.join(constraints['reasons'])}). Evidence of constrained and unconstrained areas must be submitted (5.3.5.1).")
    if inp.get("capAtElectricityLimit"):
        ol = operational_limit or {}
        if ol.get("status") == "limit" and ol.get("value") is not None and footprint and float(profile.get("giaM2") or 0) > 0 and ol.get("areaBasis") == "GIA":
            cap_kwh = ol["value"] * float(profile["giaM2"])
            target_kwh = target * float(footprint)
            if cap_kwh < target_kwh:
                target = _r(cap_kwh / float(footprint))
                steps.append(f"Reduced to the in-scope annual operational electricity limit: {ol['value']} kWh/m2GIA x {profile['giaM2']} m2 = {_r(cap_kwh)} kWh, or {target} {row.unit} over the footprint (5.3.5.1).")
            else:
                steps.append("The in-scope operational electricity limit is not lower than the target, so no reduction on that ground.")
        else:
            notes.append("The reduction to the in-scope electricity limit needs a GIA-basis operational energy limit, the GIA and the footprint.")
    systems = inp.get("systems") or []
    if systems and all(s.get("reused") for s in systems):
        target = _r(target * (1 - REUSED_SYSTEM_TARGET_REDUCTION))
        steps.append(f"Reused systems: target reduced by {int(REUSED_SYSTEM_TARGET_REDUCTION * 100)}% to {target} (5.3.5.1).")
    elif any(s.get("reused") for s in systems):
        notes.append("Some systems are reused and some are not; the 15% reduction is applied only where the generating systems are reused, so it was not applied.")
    applies = True
    if inp.get("feasibleCapacityKwp") is not None:
        floor = RENEWABLES_MIN_CAPACITY_KWP_SINGLE_FAMILY if single_family else RENEWABLES_MIN_CAPACITY_KWP_OTHER
        if float(inp["feasibleCapacityKwp"]) < floor:
            applies = False
            steps.append(f"Feasible capacity {inp['feasibleCapacityKwp']} kWp is below {floor} kWp, so the target does not apply (5.3.5.1).")
    return {"baseTarget": row.value, "target": target, "unit": row.unit, "group": group, "applies": applies, "steps": steps, "notes": notes}


# --------------------------------------------------------------------------- #
# everything a building needs, resolved once                                   #
# --------------------------------------------------------------------------- #


def resolve_limits(ref: Reference, profile: dict[str, Any], renewables_input: dict[str, Any] | None = None) -> dict[str, Any]:
    periods = reporting_periods(profile)
    building_type = classify_building(profile)
    sectors = classify_sectors(profile)
    limit_year = operational_limit_year(profile, building_type["value"], periods)
    operational = operational_energy_limit(ref, profile, sectors, building_type["value"], limit_year)
    heating = space_heating_limit(ref, profile, sectors, building_type["value"])
    erp = periods["erp"]
    embodied = [
        embodied_carbon_limit(ref, profile, sectors, w)
        for w in profile.get("works") or []
        if not w.get("completionDate") or erp["from"] <= w["completionDate"] <= erp["to"]
    ]
    gwp = other_limit(ref, "refrigerant_gwp_limit")
    return {
        "periods": periods, "buildingType": building_type, "sectors": sectors, "operationalLimitYear": limit_year,
        "operationalEnergy": operational, "spaceHeating": heating, "embodied": embodied, "pvUpfront": pv_upfront_limit(ref),
        "renewables": renewables_target_for(ref, profile, sectors, renewables_input, operational),
        "gwpLimit": {"value": gwp.value if gwp else None, "unit": gwp.unit if gwp else "kgCO2e/kg", "note": gwp.note if gwp else ""},
    }
