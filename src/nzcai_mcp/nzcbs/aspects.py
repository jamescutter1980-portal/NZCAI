"""Section 5 aspects as pure functions over the building's limit context and the
caller's figures. Each finding carries the section of the Standard it comes
from. Statuses: pass / fail (a pass-fail metric against its limit), reported (a
reporting metric), not_assessable (needed but the inputs cannot give it),
not_applicable (not required for this building).
"""

from __future__ import annotations

from typing import Any

from .classify import allowed_additional_use
from .constants import (
    DEMAND_MANAGEMENT_MAX_RESOLUTION_MINUTES,
    DEMAND_MANAGEMENT_MIN_GIA_M2,
    DHCN_FOSSIL_FREE_YEAR,
    FOSSIL_FUELS,
    OFFSET_VINTAGE_WINDOW_YEARS,
    REFRIGERANT_EXCEPTION_RPEP_BEFORE,
    SPACE_HEATING_EXISTING_FROM_YEAR,
    VERSION_1_PUBLICATION_DATE,
)
from .reference import (
    MINIMUM_OCCUPANCY_RATE,
    REFRIGERANT_CHARGE_REPORTING_THRESHOLD_KGCO2E,
    Reference,
    demand_statistics,
    find_limit,
    grid_factor,
    leakage_kg,
    network_carbon_factor,
    network_energy_use,
    network_limit,
    occupancy_rate,
)

RANK = {"fail": 4, "not_assessable": 3, "pass": 2, "reported": 1, "not_applicable": 0}


def _r(x: float, dp: int = 3) -> float:
    return round(x + 0.0, dp)


def _finding(id: str, section: str, kind: str, metric: str, status: str, value, limit, unit: str, reason: str, basis: str | None = None, gap=None) -> dict[str, Any]:
    if gap is None and kind == "pass_fail" and value is not None and limit is not None:
        gap = _r(value - limit)
    return {"id": id, "section": section, "kind": kind, "metric": metric, "status": status, "value": value, "limit": limit, "unit": unit, "gap": gap, "reason": reason, "basis": basis}


def compare(id: str, section: str, metric: str, value, limit, unit: str, reason: str, *, basis: str | None = None, missing_value: str = "No value could be computed.", missing_limit: str = "No limit could be selected.", higher_is_better: bool = False) -> dict[str, Any]:
    if limit is None:
        return _finding(id, section, "pass_fail", metric, "not_assessable", value, None, unit, missing_limit, basis)
    if value is None:
        return _finding(id, section, "pass_fail", metric, "not_assessable", None, limit, unit, missing_value, basis)
    gap = _r(value - limit)
    ok = value >= limit if higher_is_better else gap <= 0
    return _finding(id, section, "pass_fail", metric, "pass" if ok else "fail", _r(value), limit, unit, reason, basis, gap)


def reported(id: str, section: str, metric: str, value, unit: str, reason: str, basis: str | None = None) -> dict[str, Any]:
    return _finding(id, section, "reporting", metric, "not_assessable" if value is None else "reported", None if value is None else _r(value), None, unit, reason, basis)


def requirement(id: str, section: str, metric: str, met: bool | None, reason: str) -> dict[str, Any]:
    return _finding(id, section, "requirement", metric, "not_assessable" if met is None else ("pass" if met else "fail"), None, None, "", reason)


def not_applicable(id: str, section: str, metric: str, reason: str, kind: str = "pass_fail") -> dict[str, Any]:
    return _finding(id, section, kind, metric, "not_applicable", None, None, "", reason)


def overall(findings: list[dict[str, Any]]) -> str:
    decisive = [f for f in findings if f["kind"] != "reporting"]
    if not decisive:
        if any(f["status"] == "reported" for f in findings):
            return "reported"
        return "not_assessable" if any(f["status"] == "not_assessable" for f in findings) else "not_applicable"
    return max((f["status"] for f in decisive), key=lambda s: RANK[s])


def aspect(aspect_id: str, section: str, title: str, findings: list[dict[str, Any]], warnings: list[str] | None = None) -> dict[str, Any]:
    seen: list[str] = []
    for w in warnings or []:
        if w not in seen:
            seen.append(w)
    return {"aspect": aspect_id, "section": section, "title": title, "status": overall(findings), "findings": findings, "warnings": seen}


def _slug(s: str) -> str:
    import re
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


# --------------------------------------------------------------------------- #
# 5.2 operational energy                                                       #
# --------------------------------------------------------------------------- #


def _factor_for(s: dict[str, Any], grid: float | None) -> float | None:
    kind = s["kind"]
    if kind in ("grid_electricity", "chp_electricity"):
        return s.get("factorKgCo2ePerKwh") if s.get("factorKgCo2ePerKwh") is not None else grid
    if kind in ("onsite_renewable_electricity_used", "onsite_renewable_heat"):
        return 0.0
    return s.get("factorKgCo2ePerKwh")


def energy_breakdown(inp: dict[str, Any]) -> dict[str, Any]:
    gf = inp.get("gridFactors")
    grid = grid_factor(gf["generation"], gf["transmissionAndDistribution"], gf["wttGeneration"], gf["wttTransmissionAndDistribution"]) if gf else None
    by_kind: dict[str, float] = {}
    lines = []
    in_scope = additional = data_centre = excluded = 0.0
    carbon: float | None = 0.0
    measurement: list[str] = []
    for s in inp.get("supplies") or []:
        kwh = float(s["kwh"])
        if s.get("excluded"):
            excluded += kwh
            continue
        by_kind[s["kind"]] = by_kind.get(s["kind"], 0.0) + kwh
        if s.get("additionalUse"):
            additional += kwh
        elif s.get("dataCentre"):
            data_centre += kwh
        else:
            in_scope += kwh
        factor = _factor_for(s, grid)
        kg = None if factor is None else _r(kwh * factor)
        lines.append({"kind": s["kind"], "fuel": s.get("fuel"), "kwh": kwh, "factor": factor, "kgCo2e": kg})
        if kg is None:
            carbon = None
        elif carbon is not None:
            carbon += kg
        if s.get("measurement"):
            m = f"{s['kind']}: {s['measurement'].replace('_', ' ')}"
            if m not in measurement:
                measurement.append(m)
    return {"inScopeKwh": _r(in_scope), "additionalUseKwh": _r(additional), "dataCentreKwh": _r(data_centre), "excludedKwh": _r(excluded), "byKind": by_kind, "carbonKgCo2e": None if carbon is None else _r(carbon), "carbonLines": lines, "measurement": measurement, "gridFactor": grid}


def eui_denominator_gia(profile: dict[str, Any], ctx: dict[str, Any]) -> tuple[float, list[str]]:
    notes: list[str] = []
    gia = float(profile.get("giaM2") or 0)
    for a in profile.get("areas") or []:
        g = float(a.get("giaM2") if a.get("giaM2") is not None else a.get("niaM2") or 0)
        if allowed_additional_use(ctx["sectors"], a) and not a.get("outOfHoursUse"):
            gia -= g
            notes.append(f"{a['additionalUse']}: {g} m2 removed from the EUI floor area (5.2.7.1{'; NIA used as no GIA was recorded' if a.get('giaM2') is None else ''}).")
        if a.get("carPark"):
            gia -= g
            notes.append(f"Internal car park: {g} m2 removed from the EUI floor area (5.2.7.1).")
    return _r(gia), notes


def assess_operational_energy(ref: Reference, profile: dict[str, Any], ctx: dict[str, Any], inp: dict[str, Any] | None) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    warnings: list[str] = []
    limit = ctx["operationalEnergy"]
    if not inp:
        findings.append(compare("oe.eui", "5.2.7.1", "Energy use intensity", None, limit.get("value"), limit.get("unit") or "", "", missing_value="No operational energy data was supplied for the ORP."))
        return aspect("operational_energy", "5.2", "Operational energy", findings, warnings)
    b = energy_breakdown(inp)
    basis_nia = limit.get("areaBasis") == "NIA"
    if basis_nia:
        area, dnotes = float(profile.get("niaM2") or 0), ["NIA basis chosen for the Offices limit (Table 10)."]
    else:
        area, dnotes = eui_denominator_gia(profile, ctx)
    warnings += dnotes + list(limit.get("notes") or [])
    eui = _r(b["inScopeKwh"] / area) if area > 0 and b["inScopeKwh"] > 0 else None
    unit = "kWh/m2NIA/yr" if basis_nia else "kWh/m2GIA/yr"
    method = {"equation_1a": " (Equation 1a)", "equation_1b": " (Equation 1b)"}.get(limit.get("method"), "")
    findings.append(compare(
        "oe.eui", "5.2.7.1", "Energy use intensity", eui, limit["value"] if limit["status"] == "limit" else None, unit,
        f"In-scope energy {b['inScopeKwh']} kWh over {area} m2 {'NIA' if basis_nia else 'GIA'} against the Table {limit.get('table')} limit for {limit.get('year')}{method}.",
        basis="Measured: all supplies in the 5.2.1.2 scope including on-site renewable energy used on site; exported electricity, excluded uses and Additional Uses netted out (5.2.7.1).",
        missing_value="No floor area to normalise against." if area <= 0 else "No in-scope energy for the ORP.",
        missing_limit="The Standard sets no operational energy limit for this sector in this table." if limit["status"] == "no_limit" else f"No limit could be selected: {' '.join(limit.get('notes') or [])}",
    ))
    if b["additionalUseKwh"] > 0:
        findings.append(reported("oe.additional_uses", "5.2.1.3", "Additional Uses energy", b["additionalUseKwh"], "kWh/yr", "Assessed and reported separately; not required to meet the limit."))
    if b["excludedKwh"] > 0:
        findings.append(reported("oe.excluded", "5.2.1.2", "Energy excluded from the assessment", b["excludedKwh"], "kWh/yr", "Industrial process, external works, or submetered car park energy; must be stated in the submission (5.2.6)."))
    findings.append(reported("oe.total", "5.2.6", "Total energy use", b["inScopeKwh"] + b["additionalUseKwh"] + b["dataCentreKwh"], "kWh/yr", "By supply: " + "; ".join(f"{k.replace('_', ' ')} {_r(v)}" for k, v in b["byKind"].items()) + ".", basis="; ".join(b["measurement"]) or None))
    carbon_intensity = _r(b["carbonKgCo2e"] / area) if b["carbonKgCo2e"] is not None and area > 0 else None
    findings.append(reported(
        "oe.carbon_intensity", "5.2.3", "Annual operational carbon emissions intensity", carbon_intensity, "kgCO2e/m2NIA/yr" if basis_nia else "kgCO2e/m2GIA/yr",
        "An emission factor is missing for at least one in-scope supply, so no total is given. Grid electricity needs all four 5.2.3.4 lines (generation, T&D, WTT generation, WTT T&D)." if b["carbonKgCo2e"] is None
        else f"{b['carbonKgCo2e']} kgCO2e over {area} m2. This is the Standard's basis (generation + T&D + WTT), broader than GHG Protocol Scope 2 location-based reporting; do not conflate the two.",
        basis=(inp.get("gridFactors") or {}).get("reference"),
    ))
    if not inp.get("gridFactors") and any(s["kind"] == "grid_electricity" and s.get("factorKgCo2ePerKwh") is None for s in inp.get("supplies") or []):
        warnings.append("Grid electricity carbon needs the four DESNZ lines in 5.2.3.4; supplier or REGO-based factors are not permitted for grid electricity.")

    dc_areas = [a for a in profile.get("areas") or [] if a.get("sector") == "Data Centres"]
    if dc_areas or b["dataCentreKwh"] > 0:
        subsector = dc_areas[0].get("subsector") if dc_areas else None
        pue_limit = find_limit(ref, table=limit.get("table") or "OE-1", sector="Data Centres", year=ctx["operationalLimitYear"]["year"], subsector=subsector)
        total_dc = b["dataCentreKwh"] if b["dataCentreKwh"] > 0 else (b["inScopeKwh"] if len(dc_areas) == len(profile.get("areas") or []) else 0.0)
        it = inp.get("itEnergyKwh")
        pue = _r(total_dc / float(it)) if it and float(it) > 0 and total_dc > 0 else None
        findings.append(compare("oe.pue", "5.2.7.1", "Power Usage Effectiveness", pue, pue_limit.value if pue_limit.status == "limit" else None, "PUE",
                                f"Total Data Centre energy {total_dc} kWh over IT energy {it if it is not None else 'unknown'} kWh, against Table {limit.get('table') or 'OE-1'} {pue_limit.year}{f' ({subsector})' if subsector else ''}.",
                                missing_value="PUE needs the Data Centre's total energy and its IT equipment energy, each submetered (5.2.3.1).", missing_limit=" ".join(pue_limit.notes) or "No PUE limit found."))

    classification = ctx["sectors"]["classification"]
    if classification == "Hotels":
        ca, beds = inp.get("conditionedAreaM2"), inp.get("bedrooms")
        findings.append(reported("oe.per_conditioned_area", "5.2.2", "Energy use per m2 conditioned area", _r(b["inScopeKwh"] / float(ca)) if ca else None, "kWh/m2CA/yr", "" if ca else "Conditioned area not supplied."))
        findings.append(reported("oe.per_bedroom", "5.2.2", "Energy use per bedroom", _r(b["inScopeKwh"] / float(beds)) if beds else None, "kWh/bedroom/yr", "" if beds else "Number of bedrooms not supplied."))
    if any(a.get("sector") == "Retail" and (a.get("subsector") or "").lower().startswith("landlord") for a in profile.get("areas") or []):
        cpa = inp.get("commonPartsAreaM2")
        findings.append(reported("oe.per_common_parts", "5.2.2", "Energy use per m2 common parts area", _r(b["inScopeKwh"] / float(cpa)) if cpa else None, "kWh/m2CPA/yr", "" if cpa else "Common parts area not supplied."))
    if classification == "Healthcare" and ctx["buildingType"]["value"] == "New Building":
        warnings.append("New Healthcare buildings comply with the NHS Net Zero Building Standard, with domestic hot water and unregulated loads mandatory in scope (5.2.7.1).")

    occ = inp.get("occupancy")
    if not profile.get("intendedToBeOccupied", True):
        op = (occ or {}).get("operationalOnFirstDay")
        findings.append(requirement("oe.occupancy", "5.2.5.1", "Operational on the first day of the ORP", op, "Not recorded whether the building was operational on the first day of the ORP." if op is None else ("Building not intended to be occupied and operational on day one." if op else "Building not intended to be occupied but not operational on day one.")))
    elif not occ:
        findings.append(requirement("oe.occupancy", "5.2.5.1", "Occupancy rate at least 80% on the first day of the ORP", None, "No occupancy calculation (Equation 4) was supplied: floor areas, occupiable area, separately occupied spaces and unoccupiable areas are submission items (5.2.6)."))
    else:
        rate = occupancy_rate(float(occ["totalGiaM2"]), float(occ["unoccupiableGiaM2"]), float(occ["occupiedGiaM2"]))
        reason = "Total occupiable area (Ag - Au) is not positive, so no occupancy rate can be calculated (Equation 4)." if rate is None else f"Equation 4: {occ['occupiedGiaM2']} / ({occ['totalGiaM2']} - {occ['unoccupiableGiaM2']}) = {round(rate * 1000) / 10}%."
        findings.append(requirement("oe.occupancy", "5.2.5.1", "Occupancy rate at least 80% on the first day of the ORP", None if rate is None else rate >= MINIMUM_OCCUPANCY_RATE, f'{reason} Minimum {int(MINIMUM_OCCUPANCY_RATE * 100)}%. "Used by people" cannot rest on a lease alone.'))
    if ctx["buildingType"]["value"] == "Existing Building" and (profile.get("operationalRoute") or "one-go") == "stepped":
        findings.append(requirement("oe.retrofit_plan", "5.2.8", "Retrofit Plan submitted for the stepped route", None, "The stepped route requires a PAS 2035 or PAS 2038 Retrofit Plan showing the Table OE-3 limits will be met at future dates. It is recorded as an attachment; this tool cannot produce it."))
    return aspect("operational_energy", "5.2", "Operational energy", findings, warnings)


# --------------------------------------------------------------------------- #
# 5.3 renewables                                                               #
# --------------------------------------------------------------------------- #


def assess_renewables(profile: dict[str, Any], ctx: dict[str, Any], inp: dict[str, Any] | None) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    target = ctx["renewables"]
    warnings = list(target["notes"])
    footprint = profile.get("footprintM2")
    metric = "Annual on-site renewable electricity generation per m2 footprint"
    if not inp:
        findings.append(compare("re.target", "5.3.5.1", metric, None, target["target"] if target["applies"] else None, target["unit"], "", missing_value="No on-site generation data was supplied. Where there is no system, the target still applies unless reduced under 5.3.5.1; record the constraints and the feasible capacity.", missing_limit=" ".join(target["notes"])))
        return aspect("onsite_renewables", "5.3", "On-site renewable electricity generation", findings, warnings)
    systems = inp.get("systems") or []
    in_scope = [s for s in systems if s.get("consumerSideOfPrimaryMeter", True)]
    if len(in_scope) < len(systems):
        warnings.append(f"{len(systems) - len(in_scope)} system(s) are not connected on the consumer side of the primary meter and are outside the 5.3.1.2 scope.")
    generated = _r(sum(float(s["generatedKwh"]) for s in in_scope))
    exported = _r(sum(float(s.get("exportedKwh") or 0) for s in in_scope))
    capacity = _r(sum(float(s["capacityKw"]) for s in in_scope))
    findings.append(reported("re.generated", "5.3.2", "Total annual on-site renewable electricity generation", generated, "kWh/yr", f"{len(in_scope)} system(s): " + (", ".join(f"{s['technology']} {s['capacityKw']} kW" for s in in_scope) or "none") + ".", basis="Meter readings (Table 11)."))
    findings.append(reported("re.used", "5.3.2", "Annual on-site renewable electricity generation used on site", _r(generated - exported), "kWh/yr", "Generation less export (Table 11 note b). Counts in the EUI; exported electricity does not (5.3.1.2)."))
    findings.append(reported("re.exported", "5.3.2", "Annual on-site renewable electricity generation exported", exported, "kWh/yr", "Excluded from energy use; included against the target; reported under module D2 (5.3.1.2)."))
    findings.append(reported("re.capacity", "5.3.2", "On-site renewable electricity generation capacity per m2 footprint", _r(capacity / float(footprint), 4) if footprint and float(footprint) > 0 else None, "kWp/m2FP", f"{capacity} kWp over {footprint} m2 footprint." if footprint else "Building footprint not recorded (5.3.2)."))
    if not target["applies"]:
        findings.append(not_applicable("re.target", "5.3.5.1", metric, " ".join(target["steps"])))
    else:
        per_fp = _r(generated / float(footprint)) if footprint and float(footprint) > 0 else None
        findings.append(compare("re.target", "5.3.5.1", metric, per_fp, target["target"], target["unit"], f"{generated} kWh over {footprint} m2 footprint against the target {target['target']} {target['unit']}. " + " ".join(target["steps"]), missing_value="Building footprint not recorded, so generation per m2 footprint cannot be calculated.", missing_limit=" ".join(target["notes"]) or "No target could be selected.", higher_is_better=True))
    constraints = inp.get("constraints")
    if constraints and constraints.get("reasons"):
        ev = constraints.get("evidence")
        findings.append(requirement("re.constraint_evidence", "5.3.5.1", "Evidence of constrained and unconstrained areas", True if ev else None, f"Evidence recorded: {ev}." if ev else "A reduced target needs evidence showing which areas within the curtilage are constrained; rooftop plant, green roofs and amenity space do not qualify on their own (5.3.5.1 note 2)."))
    return aspect("onsite_renewables", "5.3", "On-site renewable electricity generation", findings, warnings)


# --------------------------------------------------------------------------- #
# 5.4 water                                                                    #
# --------------------------------------------------------------------------- #


def assess_water(profile: dict[str, Any], ctx: dict[str, Any], inp: dict[str, Any] | None) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    warnings: list[str] = []
    if not inp:
        findings.append(reported("wa.total", "5.4.2", "Annual operational water use", None, "m3/yr", "No water data was supplied. All water within the curtilage, including rainwater, greywater and treated blackwater, is in scope (5.4.1.2)."))
        return aspect("operational_water", "5.4", "Operational water use", findings, warnings)
    sources = [s for s in inp.get("sources") or [] if not s.get("excludedProcess")]
    total = _r(sum(float(s["m3"]) for s in sources))
    gia = float(profile.get("giaM2") or 0)
    findings.append(reported("wa.total", "5.4.2", "Annual operational water use", total, "m3/yr", "By source: " + ("; ".join(f"{s['source']} {s['m3']}" for s in sources) or "none") + ".", basis="Meter readings per source (Table 15)."))
    findings.append(reported("wa.per_gia", "5.4.2", "Annual operational water use per m2 GIA", _r(total / gia, 4) if gia > 0 else None, "m3/m2GIA/yr", "" if gia > 0 else "No GIA recorded."))
    carbon: float | None = 0.0
    for s in sources:
        f = s.get("supplyFactorKgCo2ePerM3")
        if f is None:
            carbon = None
            warnings.append(f'No supply emission factor for {s["source"]} water; use the DESNZ "water supply" factor or an equivalent-scope source factor (5.4.3.1).')
            break
        carbon += float(s["m3"]) * float(f)
    disposal = float(inp["meteredDisposalM3"]) if inp.get("meteredDisposalM3") is not None else max(0.0, total - float(inp.get("onsiteDisposalM3") or 0))
    if carbon is not None:
        tf = inp.get("treatmentFactorKgCo2ePerM3")
        if tf is None:
            carbon = None
            warnings.append('No water treatment emission factor; use the DESNZ "water treatment" factor (5.4.3.1).')
        else:
            carbon += disposal * float(tf)
    findings.append(reported("wa.carbon_per_gia", "5.4.3.1", "Annual operational water use carbon emissions per m2 GIA", _r(carbon / gia, 4) if carbon is not None and gia > 0 else None, "kgCO2e/m2GIA/yr", "An emission factor is missing." if carbon is None else f"{_r(carbon)} kgCO2e: supply on {total} m3 and treatment on {_r(disposal)} m3 ({'metered disposal' if inp.get('meteredDisposalM3') is not None else 'total consumption less on-site disposal'})."))
    c = ctx["sectors"]["classification"]
    if c in ("Homes", "Offices"):
        res = inp.get("residents")
        findings.append(reported("wa.per_person_day", "5.4.2", "Litres per person per day", _r(total * 1000 / float(res) / 365, 1) if res else None, "l/person/day", f"{res} typical residents or occupants over 365 days." if res else "Typical number of residents or occupants not supplied."))
    if c == "Schools":
        pupils = inp.get("pupils")
        findings.append(reported("wa.per_pupil", "5.4.2", "Annual operational water use per pupil", _r(total / float(pupils), 3) if pupils else None, "m3/pupil/yr", f"{pupils} pupils registered." if pupils else "Number of pupils not supplied."))
    if c == "Data Centres":
        it = inp.get("itEnergyKwh")
        findings.append(reported("wa.wue", "5.4.2", "Water Use Effectiveness", _r(total * 1000 / float(it), 4) if it else None, "WUE (l/kWh IT)", "Litres of water per kWh of IT energy." if it else "IT energy not supplied."))
    return aspect("operational_water", "5.4", "Operational water use", findings, warnings)


# --------------------------------------------------------------------------- #
# 5.5 fossil fuel free                                                         #
# --------------------------------------------------------------------------- #


def system_verdict(s: dict[str, Any]) -> tuple[bool, str]:
    fuel = s["fuel"]
    name = fuel.replace("_", " ")
    if fuel in FOSSIL_FUELS:
        if s.get("exception"):
            return True, f'{name} allowed under the 5.5.5 case "{s["exception"].replace("_", " ")}"; still measured and reported (5.5.1.1).'
        return False, f"{name} is used on site for an in-scope use with no 5.5.5 allowable case recorded{' (first-generation biofuels are treated as fossil fuels)' if fuel == 'biofuel_first_generation' else ''}."
    b = s.get("biofuel")
    if not b:
        return False, f"{name}: feedstock origin and certification evidence are missing (5.5.4, 5.5.5)."
    if b.get("feedstockOrigin") not in ("UK", "EEA"):
        return False, "Biofuel feedstock is not from the United Kingdom or the European Economic Area (5.5.5)."
    if not b.get("certifiedLowIlucRisk"):
        return False, "Biofuel is not shown to have low indirect land-use change risk under a scheme approved under the EU Renewable Energy Directive (5.5.5)."
    return True, f"{name} from {b['feedstockOrigin']} feedstock with low-iLUC certification; feedstock classification, origin, chain of custody and carbon factors are submission items (5.5.4)."


def _guess_fuel(name: str | None) -> str:
    n = (name or "").lower()
    import re
    if re.search(r"lpg|propane|butane", n):
        return "lpg"
    if "coal" in n:
        return "coal"
    if re.search(r"oil|kerosene|diesel", n):
        return "oil"
    if re.search(r"pellet|chip|wood|biomass|biogas|hvo|biodiesel", n):
        return "biofuel_second_generation"
    return "other_fossil"


def assess_fossil_fuel_free(inp: dict[str, Any] | None) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    if not inp:
        findings.append(requirement("ff.statement", "5.5.5", "No fossil fuel use on site beyond the allowable cases", None, "No fossil fuel review was supplied. The review covers drawings, specifications, energy-using systems and meter records (5.5.2.1)."))
        return aspect("fossil_fuel_free", "5.5", "Fossil fuel free", findings)
    systems = inp.get("systems") or []
    for s in systems:
        ok, reason = system_verdict(s)
        findings.append(requirement(f"ff.system.{_slug(s['description'])}", "5.5.5", f"System: {s['description']}", ok, reason))
    fossil_supplies = [s for s in inp.get("supplies") or [] if s["kind"] in ("natural_gas", "bulk_fuel") and float(s["kwh"]) > 0]
    declared = {s["fuel"] for s in systems}
    for s in fossil_supplies:
        fuel = "natural_gas" if s["kind"] == "natural_gas" else _guess_fuel(s.get("fuel"))
        if fuel not in declared:
            label = "natural gas" if s["kind"] == "natural_gas" else (s.get("fuel") or "bulk fuel")
            findings.append(requirement(f"ff.supply.{s['kind']}{'.' + _slug(s['fuel']) if s.get('fuel') else ''}", "5.5.2.1", f"{'Natural gas' if s['kind'] == 'natural_gas' else s.get('fuel') or 'Bulk fuel'} supply in the energy data", False, f"{_r(float(s['kwh']))} kWh of {label} was used in the ORP but no system using it is in the fossil fuel review. Record the system and its 5.5.5 case, or the building fails the fossil-fuel-free requirement."))
    fossil_kwh = _r(sum(float(s["kwh"]) for s in fossil_supplies))
    if fossil_kwh > 0:
        findings.append(reported("ff.fossil_kwh", "5.5.1.1", "Fossil fuel and biofuel energy used on site", fossil_kwh, "kWh/yr", "Measured, assessed and reported whatever the exception (5.5.1.1; 5.2.3.3 note 1)."))
    if not systems and not fossil_supplies:
        findings.append(requirement("ff.statement", "5.5.4", "Statement that there is no fossil fuel use on site", True, "No fossil fuel or biofuel system declared and no fossil supply in the energy data. The statement needs drawings, specifications and meter records as evidence (5.5.4)."))
    return aspect("fossil_fuel_free", "5.5", "Fossil fuel free", findings)


# --------------------------------------------------------------------------- #
# 5.6 demand management                                                        #
# --------------------------------------------------------------------------- #


def assess_demand(inp: dict[str, Any] | None) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    warnings: list[str] = []
    title = "Electricity demand management"
    if not inp:
        findings.append(reported("dm.top_ten", "5.6.3", "Top ten recorded demand values", None, "kW", "No half-hourly electricity data was supplied for the ORP."))
        return aspect("electricity_demand_management", "5.6", title, findings, warnings)
    gia = float(inp["giaM2"])
    if gia <= DEMAND_MANAGEMENT_MIN_GIA_M2:
        findings.append(not_applicable("dm.scope", "5.6.1.2", "Electricity demand management assessment", f"GIA {gia} m2 is not above {DEMAND_MANAGEMENT_MIN_GIA_M2} m2, so no assessment is required.", kind="reporting"))
        return aspect("electricity_demand_management", "5.6", title, findings, warnings)
    res = int(inp["resolutionMinutes"])
    if res > DEMAND_MANAGEMENT_MAX_RESOLUTION_MINUTES:
        findings.append(reported("dm.top_ten", "5.6.2", "Top ten recorded demand values", None, "kW", f"Metering resolution is {res} minutes; the Table 16 metrics need half-hourly or finer readings. Submit details of the metering limitation (5.6.5)."))
        return aspect("electricity_demand_management", "5.6", title, findings, warnings)
    excluded = inp.get("excludedIntervalKwh") or []
    kwh = [float(k) - float(excluded[i] if i < len(excluded) else 0) for i, k in enumerate(inp["intervalKwh"])]
    s = demand_statistics(kwh, res)
    basis = f"{s['intervals']} readings at {res}-minute resolution; kW = kWh x {60 / res:g}; percentiles by linear interpolation (spreadsheet PERCENTILE.INC) across the whole ORP (5.6.3)."
    findings.append(reported("dm.top_ten", "5.6.3", "Top ten recorded demand values", s["top_ten_kw"][0] if s["top_ten_kw"] else None, "kW", "Peak and the next nine: " + ", ".join(str(x) for x in s["top_ten_kw"]) + ".", basis))
    findings.append(reported("dm.p50", "5.6.3", "50th percentile demand value", s["p50_kw"], "kW", "Median reading.", basis))
    findings.append(reported("dm.p1", "5.6.3", "1st percentile demand value", s["p1_kw"], "kW", "Reading below which the lowest 1% fall.", basis))
    expected = round(365 * 24 * 60 / res)
    if s["intervals"] < expected * 0.9:
        warnings.append(f"Only {s['intervals']} of about {expected} expected readings were supplied; gaps must be declared (5.6.5).")
    return aspect("electricity_demand_management", "5.6", title, findings, warnings)


# --------------------------------------------------------------------------- #
# 5.7 district networks                                                        #
# --------------------------------------------------------------------------- #


def assess_district_networks(inp: dict[str, Any] | None, rpep: str) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    title = "District heating and cooling networks"
    if not inp or not inp.get("networks"):
        findings.append(not_applicable("dh.scope", "5.7.1.1", title, "The building is not recorded as connected to a district heating or cooling network."))
        return aspect("district_networks", "5.7", title, findings)
    grid = float(inp["gridFactorKgCo2ePerKwh"])
    for n in inp["networks"]:
        key = _slug(n["name"])
        factor = network_carbon_factor(float(n["generationKgCo2e"]), float(n["distributionKgCo2e"]), float(n["systemDeliveredKwh"]), float(n.get("recoveredHeatKgCo2e") or 0))
        lim = network_limit(n["service"], bool(n["existing"]), grid)
        what = "heat" if n["service"] == "heating" else "coolth"
        findings.append(compare(f"dh.{key}.carbon_content", "5.7.6.2" if n["existing"] else "5.7.6.3", f"{n['name']}: carbon content of {what} supplied", factor, lim["value"], "kgCO2e/kWh",
                                f"Equation 2b: ({n['generationKgCo2e']}{f' - {n['recoveredHeatKgCo2e']} recovered' if n.get('recoveredHeatKgCo2e') else ''} + {n['distributionKgCo2e']}) / {n['systemDeliveredKwh']} = {factor}. Limit by Equation {lim['equation']} for an {'existing' if n['existing'] else 'new'} network using the 5.2.3.4 grid factor {grid}. The limit applies to the whole network with no sleeving (5.7.6.1 note 2).",
                                missing_value="The network's delivered energy and carbon for the ORP are needed (5.7.5)."))
        findings.append(reported(f"dh.{key}.energy_use", "5.2.3.6", f"{n['name']}: energy used by the network for this building", network_energy_use(float(n["generationInputKwh"]), float(n["distributionInputKwh"]), float(n["meteredKwh"]), float(n["systemDeliveredKwh"])), "kWh/yr", f"Equation 2a: ({n['generationInputKwh']} + {n['distributionInputKwh']}) x ({n['meteredKwh']} / {n['systemDeliveredKwh']}). Counts in the building's operational energy (5.2.3.1)."))
        findings.append(reported(f"dh.{key}.carbon", "5.7.2", f"{n['name']}: carbon emissions associated with {what} supplied", None if factor is None else _r(factor * float(n["meteredKwh"])), "kgCO2e/yr", f"{n['meteredKwh']} kWh metered at the connection x {factor}."))
        if n.get("suppliesFossilHeat"):
            if n["existing"]:
                beyond = int(rpep[:4]) >= DHCN_FOSSIL_FREE_YEAR
                plan = n.get("decarbonisationPlanInPlace")
                findings.append(requirement(f"dh.{key}.fossil_plan", "5.7.6.2", f"{n['name']}: plan to end fossil fuel use by {DHCN_FOSSIL_FREE_YEAR}", False if beyond else plan,
                                            f"From 1 January {DHCN_FOSSIL_FREE_YEAR} heat from an existing network may not come from fossil fuels." if beyond else ("A published plan is in place; the 5.7.5 details (statement, plant, calculations, business model) are submission items." if plan else "An existing network still using fossil fuels needs a published plan to stop by 2040 (5.7.5, 5.7.6.2).")))
            else:
                findings.append(requirement(f"dh.{key}.fossil_free", "5.7.6.3", f"{n['name']}: no fossil heat from a new network", False, "Heat or coolth from a new network shall not come from fossil fuels."))
    return aspect("district_networks", "5.7", title, findings)


# --------------------------------------------------------------------------- #
# 5.8 space heating and cooling                                                #
# --------------------------------------------------------------------------- #


def assess_space_heating(profile: dict[str, Any], ctx: dict[str, Any], inp: dict[str, Any] | None) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    limit = ctx["spaceHeating"]
    warnings = list(limit.get("notes") or [])
    title = "Space heating and cooling delivered to the building"
    is_new = ctx["buildingType"]["value"] == "New Building"
    rpep_year = int(profile["rpep"][:4])
    inp = inp or {}
    required = is_new or rpep_year >= SPACE_HEATING_EXISTING_FROM_YEAR or bool(inp.get("heatMetersInstalled"))
    if not required:
        findings.append(not_applicable("sh.scope", "5.8.1.1", "Heating and cooling delivered to the building", f"Existing Building with an RPEP before {SPACE_HEATING_EXISTING_FROM_YEAR} and no heat meters installed: not required in this version.", kind="reporting"))
        return aspect("space_heating_cooling", "5.8", title, findings, warnings)
    area = inp.get("occupiedGiaM2")
    heating, cooling = inp.get("heatingDeliveredKwh"), inp.get("coolingDeliveredKwh")

    def per_m2(kwh):
        return _r(float(kwh) / float(area)) if kwh is not None and area and float(area) > 0 else None

    basis = "VRF delivery calculated from submetered electricity, system efficiency and the heating/cooling split (5.8.3); calculations are a submission item." if inp.get("vrfCalculated") else "Heat and coolth meter readings (5.8.1.1)."
    if limit["status"] == "limit":
        findings.append(compare("sh.heating_limit", "5.8.5.2", "Annual space heating delivered to the building", per_m2(heating), limit["value"], "kWh/m2GIA/yr", f"{heating} kWh over {area} m2 occupied GIA against Table OE-4 for {limit['year']}.", basis=basis, missing_value="No delivered heating figure for the ORP." if heating is None else "No occupied GIA to normalise against (Table 18 note a)."))
    else:
        findings.append(reported("sh.heating", "5.8.2", "Annual space heating delivered to the building", per_m2(heating), "kWh/m2GIA/yr", "No delivered heating figure for the ORP." if heating is None else (limit["notes"][0] if limit.get("notes") else ""), basis))
    findings.append(reported("sh.cooling", "5.8.2", "Annual space cooling delivered to the building", per_m2(cooling), "kWh/m2GIA/yr", "No delivered cooling figure for the ORP." if cooling is None else "", basis))
    ph, pc = inp.get("peakHeatingKw"), inp.get("peakCoolingKw")
    findings.append(reported("sh.peak_heating", "5.8.2", "Peak energy delivered for space heating", _r(float(ph) * 1000 / float(area), 1) if ph is not None and area else None, "W/m2GIA", "No peak heating figure." if ph is None else ""))
    findings.append(reported("sh.peak_cooling", "5.8.2", "Peak energy delivered for space cooling", _r(float(pc) * 1000 / float(area), 1) if pc is not None and area else None, "W/m2GIA", "No peak cooling figure." if pc is None else ""))
    if ctx["sectors"]["classification"] == "Data Centres":
        warnings.append("Data Centres have no limit, but all heat demand shall be met by heat re-use within the data centre (5.8.5.1).")
    return aspect("space_heating_cooling", "5.8", title, findings, warnings)


# --------------------------------------------------------------------------- #
# 5.9 refrigerants                                                             #
# --------------------------------------------------------------------------- #


def gwp_exception(s: dict[str, Any], rpep: str) -> tuple[bool, str]:
    ex = s.get("exception")
    if ex == "cannot_retrofit":
        return True, "Exception: it is not possible to retrofit the system to a replacement refrigerant for health and safety or physical site reasons (5.9.6); evidence required."
    if ex == "installed_before_v1_no_works":
        before = bool(s.get("installDate")) and s["installDate"] < VERSION_1_PUBLICATION_DATE
        rpep_ok = rpep < REFRIGERANT_EXCEPTION_RPEP_BEFORE
        if before and rpep_ok:
            return True, f"Exception: installed {s['installDate']}, before Version 1, with no works since, and the RPEP is before 1 January 2030 (5.9.6)."
        return False, (f"The pre-Version-1 exception needs an installation date before {VERSION_1_PUBLICATION_DATE}; recorded: {s.get('installDate') or 'none'}." if not before else f"The pre-Version-1 exception lapses for an RPEP on or after {REFRIGERANT_EXCEPTION_RPEP_BEFORE}.")
    return False, ""


def assess_refrigerants(ctx: dict[str, Any], inp: dict[str, Any] | None, rpep: str) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    warnings: list[str] = []
    gwp_limit = ctx["gwpLimit"]["value"]
    if inp is None:
        findings.append(compare("rf.gwp", "5.9.6", "GWP of refrigerants in each in-scope system", None, gwp_limit, "kgCO2e/kg", "", missing_value="No refrigerant system register was supplied. Every fixed air conditioning, heat pump, chiller, VRF and refrigeration system is in scope (5.9.1.2)."))
        return aspect("refrigerants", "5.9", "Refrigerants", findings, warnings)
    systems = inp.get("systems") or []
    if not systems:
        findings.append(requirement("rf.none", "5.9.1.2", "In-scope refrigerant systems", True, "No system containing refrigerant is recorded. A written statement to that effect is a submission item (5.9.5)."))
        return aspect("refrigerants", "5.9", "Refrigerants", findings, warnings)
    charge = _r(sum(float(s["chargeKg"]) * float(s["gwp"]) for s in systems))
    findings.append(reported("rf.charge", "5.9.1.2", "Refrigerant gas charge in the building", charge, "kgCO2e", f"Equation 8 across {len(systems)} system(s): " + "; ".join(f"{s['id']} {s['chargeKg']} kg x {s['gwp']}" for s in systems) + "."))
    for s in systems:
        f = compare(f"rf.gwp.{s['id']}", "5.9.6", f"{s['id']} ({s.get('systemType', '')}, {s['refrigerant']}): GWP", float(s["gwp"]), gwp_limit, "kgCO2e/kg", f"GWP {s['gwp']} against the Annex A4 limit {gwp_limit}. {ctx['gwpLimit']['note']}", missing_limit="No GWP limit loaded.")
        if f["status"] == "fail":
            ok, reason = gwp_exception(s, rpep)
            if ok:
                f["status"] = "pass"
                f["reason"] = f"GWP {s['gwp']} exceeds the limit {gwp_limit}. {reason}"
            elif reason:
                f["reason"] += " " + reason
            findings.append(f)
            ld = s.get("leakDetectionFitted")
            findings.append(requirement(f"rf.leak_detection.{s['id']}", "5.9.6", f"{s['id']}: leak detection fitted", ld, "Leak detection fitted to shut the system down on a leak." if ld else "Where the GWP limit is exceeded the system shall be fitted with leak detection that facilitates shutdown (5.9.6)."))
        else:
            findings.append(f)
    if charge >= REFRIGERANT_CHARGE_REPORTING_THRESHOLD_KGCO2E:
        by_ref: dict[str, dict[str, Any]] = {}
        missing = False
        for s in systems:
            kg, eq = leakage_kg(s)
            if kg is None:
                missing = True
                warnings.append(f"{s['id']}: no refrigerant added or start and end charge recorded for the ORP; servicing records are a submission item (5.9.5).")
                continue
            e = by_ref.setdefault(s["refrigerant"], {"kg": 0.0, "kgCo2e": 0.0, "kyoto": s.get("kyoto", True)})
            e["kg"] += kg
            e["kgCo2e"] += kg * float(s["gwp"])
        kyoto = _r(sum(e["kgCo2e"] for e in by_ref.values() if e["kyoto"]))
        other = _r(sum(e["kgCo2e"] for e in by_ref.values() if not e["kyoto"]))
        findings.append(reported("rf.leakage_kyoto", "5.9.3", "Annual carbon impact of refrigerant leakage, Kyoto protocol gases", None if (missing and not by_ref) else kyoto, "kgCO2e/yr", f"Charge {charge} kgCO2e is at or above {REFRIGERANT_CHARGE_REPORTING_THRESHOLD_KGCO2E}, so leakage is assessed. Per refrigerant: " + ("; ".join(f"{r} {_r(e['kg'], 4)} kg = {_r(e['kgCo2e'])} kgCO2e" for r, e in by_ref.items()) or "none") + "." + (" Some systems have no leakage data, so the total is incomplete." if missing else ""), basis="Equation 9c with GWP from the DESNZ full set."))
        if other > 0:
            findings.append(reported("rf.leakage_other", "5.9.3", "Annual carbon impact of refrigerant leakage, other gases", other, "kgCO2e/yr", "Optional reporting for non-Kyoto gases."))
    else:
        warnings.append(f"Charge {charge} kgCO2e is below {REFRIGERANT_CHARGE_REPORTING_THRESHOLD_KGCO2E}, so leakage carbon is not required; the GWP limit still applies to every system (5.9.6 note 1).")
    return aspect("refrigerants", "5.9", "Refrigerants", findings, warnings)


# --------------------------------------------------------------------------- #
# 5.10 offsets                                                                 #
# --------------------------------------------------------------------------- #


def assess_offsets(inp: dict[str, Any] | None, rpep: str) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    warnings: list[str] = []
    credits = (inp or {}).get("credits") or []
    procurement = (inp or {}).get("procurement") or []
    if not inp or (not credits and not procurement):
        findings.append(not_applicable("of.scope", "5.10.1.1", "Carbon offsetting", 'No offsetting is claimed, so section 5.10 does not apply and the claim cannot carry "(plus offsets)".', kind="requirement"))
        return aspect("carbon_offsetting", "5.10", "Carbon offsetting", findings, warnings)
    rpep_year = int(rpep[:4])
    valid_credits = 0.0
    for c in credits:
        problems = []
        if c.get("scheme") not in ("ICROA", "ICVCM"):
            problems.append("not from an ICROA-endorsed standard or an ICVCM Core Carbon Principle label (5.10.2.1)")
        if abs(int(c["vintageYear"]) - rpep_year) > OFFSET_VINTAGE_WINDOW_YEARS:
            problems.append(f"vintage {c['vintageYear']} is more than {OFFSET_VINTAGE_WINDOW_YEARS} years from the RPEP year {rpep_year}")
        if not c.get("retired"):
            problems.append("not retired")
        ok = not problems
        if ok:
            valid_credits += float(c["tonnesCo2e"]) * 1000
        ident = _slug(c.get("registryReference") or f"{c.get('scheme')}_{c['vintageYear']}")
        findings.append(requirement(f"of.credit.{ident}", "5.10.2.1", f"Credits {c.get('registryReference') or ''} {c['tonnesCo2e']} tCO2e ({c.get('scheme')}, vintage {c['vintageYear']})", ok, "Eligible credits, retired for the in-scope emissions." if ok else "Not eligible: " + "; ".join(problems) + "."))
    procurement_kg = 0.0
    scope2 = inp.get("gridElectricityScope2KgCo2e")
    for p in procurement:
        problems = []
        if p["type"] == "ukgbc_silver_or_gold" and not p.get("confirmedByExpert"):
            problems.append("the UKGBC rating must be confirmed by a procurement expert with at least three years' experience")
        if p["type"] == "deep_green_rego_tariff" and not p.get("regosRetired"):
            problems.append("all REGOs from UK generators must be retired and the tariff must be Deep Green")
        if p["type"] == "direct_ppa" and not p.get("ppaWithinThreeYearsOfConstruction"):
            problems.append("the PPA must have been entered within three years of the generator's construction")
        ok = not problems
        cov = float(p.get("orpCoverage") or 0)
        findings.append(requirement(f"of.procurement.{p['type']}", "5.10.2.2", f"Renewable electricity procurement ({p['type'].replace('_', ' ')}) covering {p.get('kwhCovered')} kWh", ok, f"Eligible; covers {round(cov * 100)}% of the ORP, so only that share of grid electricity Scope 2 may be offset this way." if ok else "Not eligible: " + "; ".join(problems) + "."))
        if ok and scope2 is not None:
            procurement_kg += float(scope2) * min(1.0, max(0.0, cov))
    procurement_kg = min(procurement_kg, float(scope2 or 0))
    if procurement_kg > 0:
        warnings.append("Renewable procurement covers grid electricity Scope 2 only; T&D and WTT emissions must be offset with carbon credits (5.10.2.2).")
    covered = _r(valid_credits + procurement_kg)
    in_scope = float(inp["inScopeEmissionsKgCo2e"])
    findings.append(reported("of.in_scope", "5.10.1.2", "Total in-scope carbon emissions", in_scope, "kgCO2e", "Upfront carbon, operational energy, water and Kyoto refrigerant leakage as a minimum."))
    findings.append(requirement("of.quantity", "5.10.2.3", "Offsets equal the in-scope emissions", covered >= in_scope, f"{covered} kgCO2e covered ({_r(valid_credits)} by eligible credits{f', {_r(procurement_kg)} by eligible procurement' if procurement_kg else ''}) against {in_scope} kgCO2e in scope."))
    return aspect("carbon_offsetting", "5.10", "Carbon offsetting", findings, warnings)


# --------------------------------------------------------------------------- #
# 5.1 embodied carbon                                                          #
# --------------------------------------------------------------------------- #


def assess_embodied_carbon(profile: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    selections = {e["worksId"]: e for e in ctx["embodied"]}
    works = [w for w in profile.get("works") or [] if w.get("id") in selections]
    if not works:
        erp = ctx["periods"]["erp"]
        findings.append(not_applicable("ec.scope", "5.1.2.1", "Embodied carbon", f"No New, Retrofit or Reportable Works completed within the ERP ({erp['from']} to {erp['to']}), so no embodied carbon assessment is required (4.2.1.1)."))
        return aspect("embodied_carbon", "5.1", "Embodied carbon", findings)
    for w in works:
        sel = selections[w["id"]]
        e = w.get("embodied") or {}
        gia = e.get("giaM2")
        upfront = e.get("upfrontKgCo2e")
        if sel.get("reportableScope") == "Cat B" and e.get("upfrontCatBKgCo2e") is not None:
            upfront = e["upfrontCatBKgCo2e"]
        per_m2 = _r(float(upfront) / float(gia)) if upfront is not None and gia and float(gia) > 0 else None
        label = f"{w['id']} ({sel['worksType']}, commenced {w['commencementDate']})"
        if sel["worksType"] == "Non-Reportable Works":
            findings.append(not_applicable(f"ec.{w['id']}.upfront", "5.1.2.1", f"{label}: upfront carbon", "Non-Reportable Works are outside the embodied carbon scope."))
            continue
        if not sel["compare"]:
            findings.append(reported(f"ec.{w['id']}.upfront", "5.1.6", f"{label}: upfront carbon", per_m2, "kgCO2e/m2GIA", " ".join(sel["notes"]) or "Assessed and reported; not compared with a limit.", basis="Imported RICS PS assessment."))
            continue
        findings.append(compare(
            f"ec.{w['id']}.upfront", "5.1.6.2" if sel.get("table") == "EC-3" else "5.1.6.1",
            f"{label}: upfront carbon{f' ({sel['reportableScope']})' if sel.get('reportableScope') else ''}",
            per_m2, sel["value"] if sel["status"] == "limit" else None, "kgCO2e/m2GIA",
            f"{upfront} kgCO2e over {gia} m2 GIA against Table {sel.get('table')} for {sel['year']}{' (Equation 1a)' if sel.get('method') == 'equation_1a' else ''}. " + " ".join(sel["notes"]),
            basis="Imported RICS PS whole life carbon assessment; material quantities, factor sources and uncertainty are submission items (5.1.5).",
            missing_value="No upfront carbon figure imported for these works." if upfront is None else "No GIA recorded for the works.",
            missing_limit=(f"No limit in Table {sel.get('table')} for this sector. " if sel["status"] == "no_limit" else "") + " ".join(sel["notes"]),
        ))
        if e.get("lifeCycleKgCo2ePerM2") is not None:
            findings.append(reported(f"ec.{w['id']}.life_cycle", "5.1.6.3", f"{label}: life cycle embodied carbon", float(e["lifeCycleKgCo2ePerM2"]), "kgCO2e/m2GIA", "No life cycle limit in this version; reported."))
        if e.get("genericSpecificationKgCo2ePerM2") is not None:
            findings.append(reported(f"ec.{w['id']}.generic", "5.1.2.6", f"{label}: upfront carbon with generic material specifications", float(e["genericSpecificationKgCo2ePerM2"]), "kgCO2e/m2GIA", "Reporting metric (Table 8)."))
        if e.get("pvKwp"):
            per_kwp = _r(float(e["pvUpfrontKgCo2e"]) / float(e["pvKwp"])) if e.get("pvUpfrontKgCo2e") is not None else None
            pv = ctx["pvUpfront"]
            findings.append(compare(f"ec.{w['id']}.pv", "5.1.6.4", f"{label}: PV upfront carbon per kWp", per_kwp, pv["value"], pv["unit"], f"{e.get('pvUpfrontKgCo2e')} kgCO2e over {e['pvKwp']} kWp against Table EC-5. " + " ".join(pv["notes"]), missing_value="No upfront carbon figure for the PV system.", missing_limit="No PV limit loaded."))
    return aspect("embodied_carbon", "5.1", "Embodied carbon", findings)
