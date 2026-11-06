"""UK NZCBS V1 Rev 1 rule engine for NZC AI: one call that classifies the
building, selects its limits and assesses every aspect of section 5 from the
figures supplied. Pure: the caller loads the reference tables and gathers the
inputs; nothing here reads a database or the network.

The governing rule: no limit, benchmark or building value is invented. Where the
Standard sets no limit the finding says so; where the inputs cannot give a value
the finding is not assessable with the reason; neither is ever a pass.
"""

from __future__ import annotations

from typing import Any

from .aspects import (
    aspect,
    assess_demand,
    assess_district_networks,
    assess_embodied_carbon,
    assess_fossil_fuel_free,
    assess_offsets,
    assess_operational_energy,
    assess_refrigerants,
    assess_renewables,
    assess_space_heating,
    assess_water,
    overall,
    requirement,
)
from .classify import NzcbsInputError, pct
from .limits import resolve_limits
from .reference import DISCLAIMER, PRE_VERIFICATION_STATEMENT, STANDARD_NAME, Reference

STATUSES = ("pass", "fail", "reported", "not_assessable", "not_applicable")


def _classification_aspect(profile: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """The classification is itself a submission item (4.2.7), so it is reported as an aspect."""
    s = ctx["sectors"]
    bt = ctx["buildingType"]
    ly = ctx["operationalLimitYear"]
    findings = [
        requirement("cl.can_claim", "4.2.2", "Less than 30% of NIA unclassifiable", s["canClaim"], f"{pct(s['unclassifiableShare'])} of NIA is unclassifiable." if s["canClaim"] else next((r for r in s["reasons"] if "unclassifiable" in r), "")),
        requirement("cl.building_type", bt["section"], f"Building type: {bt['value']}", True, " ".join(bt["reasons"])),
        requirement("cl.sector", "4.2.2", f"Classification: {s['classification']}", bool(s["sectors"]), " ".join(s["reasons"])),
    ]
    for u in s["additionalUses"]:
        findings.append(requirement(f"cl.additional_use.{u['label'].lower().replace(' ', '_')}", "5.2.1.3", f"Additional Use: {u['label']} ({u['niaM2']} m2 NIA)", u["allowed"], u["reason"]))
    findings.append(requirement("cl.limit_year", ly["section"], f"Operational energy limit year: {ly['year']}", True, ly["rule"]))
    if not profile.get("footprintM2"):
        findings.append(requirement("cl.footprint", "5.3.2", "Building footprint recorded", None, "The renewables target is per m2 of building footprint; none is recorded."))
    if not profile.get("region"):
        findings.append(requirement("cl.region", "Annex A3", "Annex A3 region recorded", None, "The renewables target depends on the region; none is recorded."))
    return aspect("classification", "4", "Classification and reporting periods", findings, list(ctx["periods"]["reasons"]))


def validate_profile(profile: dict[str, Any]) -> None:
    if not isinstance(profile, dict):
        raise NzcbsInputError("profile must be an object.")
    if not profile.get("rpep"):
        raise NzcbsInputError("profile.rpep (Reporting Period End Point, ISO date) is required (4.2.4.1).")
    if not isinstance(profile.get("areas"), list) or not profile["areas"]:
        raise NzcbsInputError("profile.areas must list at least one floor area with a Table 6 sector and niaM2 (4.2.2).")
    for a in profile["areas"]:
        if "niaM2" not in a:
            raise NzcbsInputError("Every area needs niaM2.")
    for key in ("giaM2", "niaM2"):
        if profile.get(key) is None:
            raise NzcbsInputError(f"profile.{key} is required (4.2.7).")


def assess_building(ref: Reference, profile: dict[str, Any], inputs: dict[str, Any] | None = None) -> dict[str, Any]:
    validate_profile(profile)
    inputs = inputs or {}
    ctx = resolve_limits(ref, profile, inputs.get("renewables"))
    energy = inputs.get("energy")
    fossil = inputs.get("fossilFuels")
    if fossil is not None:
        fossil = {**fossil, "supplies": fossil.get("supplies") if fossil.get("supplies") is not None else (energy or {}).get("supplies")}
    elif energy is not None:
        fossil = {"systems": [], "supplies": energy.get("supplies")}
    aspects = [
        _classification_aspect(profile, ctx),
        assess_embodied_carbon(profile, ctx),
        assess_operational_energy(ref, profile, ctx, energy),
        assess_renewables(profile, ctx, inputs.get("renewables")),
        assess_water(profile, ctx, inputs.get("water")),
        assess_fossil_fuel_free(fossil),
        assess_demand(inputs.get("demand")),
        assess_district_networks(inputs.get("districtNetworks"), profile["rpep"]),
        assess_space_heating(profile, ctx, inputs.get("spaceHeating")),
        assess_refrigerants(ctx, inputs.get("refrigerants"), profile["rpep"]),
        assess_offsets(inputs.get("offsets"), profile["rpep"]),
    ]
    all_findings = [f for a in aspects for f in a["findings"]]
    counts = {s: 0 for s in STATUSES}
    for f in all_findings:
        counts[f["status"]] += 1
    warnings: list[str] = []
    for a in aspects:
        for w in a["warnings"]:
            if w not in warnings:
                warnings.append(w)
    return {
        "standard": f"{STANDARD_NAME}, {ref.manifest.get('standard', '').split(', ', 1)[-1]}",
        "reference": ref.label(),
        "version": ref.version,
        "rpep": profile["rpep"],
        "orp": ctx["periods"]["orp"],
        "erp": ctx["periods"]["erp"],
        "buildingType": ctx["buildingType"]["value"],
        "classification": ctx["sectors"]["classification"],
        "sectors": [{"sector": s["sector"], "share": s["share"]} for s in ctx["sectors"]["sectors"]],
        "limitYear": ctx["operationalLimitYear"]["year"],
        "limits": {
            "operationalEnergy": ctx["operationalEnergy"],
            "spaceHeating": ctx["spaceHeating"],
            "embodied": ctx["embodied"],
            "pvUpfront": ctx["pvUpfront"],
            "renewables": ctx["renewables"],
            "gwpLimit": ctx["gwpLimit"],
            "operationalLimitYear": ctx["operationalLimitYear"],
        },
        "aspects": aspects,
        "status": overall(all_findings),
        "counts": counts,
        "permittedStatement": PRE_VERIFICATION_STATEMENT,
        "disclaimer": DISCLAIMER,
        "warnings": warnings,
    }


def classify_building_profile(ref: Reference, profile: dict[str, Any]) -> dict[str, Any]:
    """Classification and limit selection only, without any measured figures."""
    validate_profile(profile)
    ctx = resolve_limits(ref, profile, None)
    return {
        "version": ref.version,
        "periods": ctx["periods"],
        "buildingType": ctx["buildingType"],
        "sectors": ctx["sectors"],
        "operationalLimitYear": ctx["operationalLimitYear"],
        "operationalEnergyLimit": ctx["operationalEnergy"],
        "spaceHeatingLimit": ctx["spaceHeating"],
        "embodiedLimits": ctx["embodied"],
        "pvUpfrontLimit": ctx["pvUpfront"],
        "renewablesTarget": ctx["renewables"],
        "gwpLimit": ctx["gwpLimit"],
        "permittedStatement": PRE_VERIFICATION_STATEMENT,
        "disclaimer": DISCLAIMER,
    }
