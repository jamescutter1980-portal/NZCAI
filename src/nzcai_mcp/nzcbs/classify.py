"""Section 4 classification: building type (Table 4), works type (Table 5),
sectors and subsectors (4.2.2), Table 9 Additional Uses, Table 12 uses, the
reporting periods (4.2.4) and the Annex A3 region.

Inputs are plain dicts in the shape the MCP tools document (camelCase keys, as
the portal's engine names them). Every function returns its reasoning, because
the classification is itself a submission item (4.2.7).
"""

from __future__ import annotations

from datetime import date
from typing import Any

from .constants import (
    ADDITIONAL_USE_NIA_SHARE_LIMIT,
    ADDITIONAL_USES_BY_SECTOR,
    ERP_YEARS,
    MINOR_SECTOR_NIA_SHARE,
    PARTICULAR_USE_LIMIT_SECTOR,
    SECTORS,
    SOUTH_ENGLAND_COUNTIES,
    UNCLASSIFIABLE_NIA_SHARE_LIMIT,
)
from .reference import NEW_BUILDING_NIA_SHARE, works_type as _works_type_from_facts


class NzcbsInputError(ValueError):
    """The caller's building description cannot be used as given."""


def pct(x: float) -> str:
    return f"{round(x * 1000) / 10}%"


def _num(d: dict[str, Any], key: str, default: float = 0.0) -> float:
    v = d.get(key)
    return float(v) if v is not None else default


# --------------------------------------------------------------------------- #
# reporting periods                                                            #
# --------------------------------------------------------------------------- #


def _shift(iso: str, years: int) -> str:
    d = date.fromisoformat(iso)
    try:
        return d.replace(year=d.year + years).isoformat()
    except ValueError:  # 29 February
        return d.replace(year=d.year + years, day=28).isoformat()


def reporting_periods(profile: dict[str, Any]) -> dict[str, Any]:
    """4.2.4: ORP is the year before the RPEP; ERP five years before it or since the previous RPEP if sooner."""
    rpep = profile.get("rpep")
    if not rpep:
        raise NzcbsInputError("rpep (Reporting Period End Point, ISO date) is required (4.2.4.1).")
    orp_from = _shift(rpep, -1)
    five = _shift(rpep, -ERP_YEARS)
    previous = profile.get("previousRpep")
    reasons = [f"ORP runs from {orp_from} to the RPEP {rpep} (4.2.4.2)."]
    erp_from = five
    if previous and previous > five:
        erp_from = previous
        reasons.append(f"ERP starts at the previous RPEP {previous}, which is within five years (4.2.4.2).")
    else:
        reasons.append(f"ERP starts five years before the RPEP, {five} (4.2.4.2).")
    if previous and _shift(previous, 1) < rpep:
        reasons.append(f"The RPEP is more than twelve months after the previous RPEP {previous}, so there is a gap in claim validity that must be communicated (4.2.4.1 note 2, 7.2).")
    return {"rpep": rpep, "orp": {"from": orp_from, "to": rpep}, "erp": {"from": erp_from, "to": rpep}, "orpStartYear": int(orp_from[:4]), "reasons": reasons}


# --------------------------------------------------------------------------- #
# works and building type                                                      #
# --------------------------------------------------------------------------- #


def works_type(works: dict[str, Any]) -> dict[str, Any]:
    """Table 5: as declared, or classified from the works' facts."""
    if works.get("type"):
        return {"value": works["type"], "section": "4.2.1 Table 5", "reasons": ["Works type as declared."]}
    facts = works.get("facts") or {}
    value = _works_type_from_facts(facts)
    reasons = {
        "New Works": "At least 50% of NIA is new, or a single-storey building with everything above the slab new.",
        "Retrofit Works": "At least 10% of the thermal envelope or glazed area is new, upgraded or replaced.",
        "Reportable Works": "Works worth at least £100,000, or new or replacement HVAC plant, or replacement lighting.",
        "Non-Reportable Works": "First fit-out belongs to the preceding works (note c)." if facts.get("firstFitOut") else "None of the New, Retrofit or Reportable Works tests is met.",
    }
    return {"value": value, "section": "4.2.1 Table 5", "reasons": [reasons[value]]}


def classify_building(profile: dict[str, Any]) -> dict[str, Any]:
    """Table 4."""
    if profile.get("previouslyClassifiedNewBuilding"):
        return {"value": "New Building", "section": "4.2.1 Table 4", "reasons": ["Previously defined as a New Building in a submission under this Standard."]}
    areas = profile.get("areas") or []
    nia = _num(profile, "niaM2") or sum(_num(a, "niaM2") for a in areas)
    new_nia = sum(_num(a, "niaM2") for a in areas if a.get("newArea"))
    share = new_nia / nia if nia > 0 else 0.0
    if share >= NEW_BUILDING_NIA_SHARE:
        return {"value": "New Building", "section": "4.2.1 Table 4", "reasons": [f"{pct(share)} of NIA is New Area (3.1.4.10), at or above the {pct(NEW_BUILDING_NIA_SHARE)} test."]}
    for w in profile.get("works") or []:
        if (w.get("facts") or {}).get("singleStoreyAllNewAboveSlab"):
            return {"value": "New Building", "section": "4.2.1 Table 4", "reasons": [f"Works {w.get('id')}: single-storey with every element above the ground floor slab new."]}
    return {"value": "Existing Building", "section": "4.2.1 Table 4", "reasons": [f"{pct(share)} of NIA is New Area, below the {pct(NEW_BUILDING_NIA_SHARE)} test, and no other Table 4 criterion applies."]}


# --------------------------------------------------------------------------- #
# sectors                                                                      #
# --------------------------------------------------------------------------- #


def classify_sectors(profile: dict[str, Any]) -> dict[str, Any]:
    """4.2.2 steps 1 to 4, with Table 9 Additional Uses checked."""
    areas = profile.get("areas") or []
    reasons: list[str] = []
    total = sum(_num(a, "niaM2") for a in areas) or _num(profile, "niaM2")
    unclassifiable = sum(_num(a, "niaM2") for a in areas if a.get("sector") is None)
    unclassifiable_share = unclassifiable / total if total > 0 else 0.0
    can_claim = unclassifiable_share < UNCLASSIFIABLE_NIA_SHARE_LIMIT
    if not can_claim:
        reasons.append(f"{pct(unclassifiable_share)} of NIA is unclassifiable, at or above {pct(UNCLASSIFIABLE_NIA_SHARE_LIMIT)}, so the building cannot claim conformity (4.2.2 step 1).")

    by_sector: dict[str, dict[str, Any]] = {}
    for a in areas:
        s = a.get("sector")
        if s is None:
            continue
        if s not in SECTORS:
            raise NzcbsInputError(f'"{s}" is not a Table 6 sector. Sectors: {", ".join(SECTORS)}.')
        e = by_sector.setdefault(s, {"sector": s, "niaM2": 0.0, "share": 0.0, "parts": []})
        e["niaM2"] += _num(a, "niaM2")
        e["parts"].append({"subsector": a.get("subsector"), "scope": a.get("scope"), "niaM2": _num(a, "niaM2"), "newArea": bool(a.get("newArea")), "particularUse": a.get("particularUse")})
    all_sectors = sorted(by_sector.values(), key=lambda e: -e["niaM2"])
    for e in all_sectors:
        e["share"] = round(e["niaM2"] / total, 4) if total > 0 else 0.0
    omit = profile.get("omitMinorSectors", True)
    omitted = [e for e in all_sectors if e["share"] < MINOR_SECTOR_NIA_SHARE] if omit and len(all_sectors) > 1 else []
    kept = [e for e in all_sectors if e not in omitted]
    if omitted:
        reasons.append(f"Omitted from classification and limit-setting as under {pct(MINOR_SECTOR_NIA_SHARE)} of NIA (4.2.2 step 3): {', '.join(f'{e['sector']} {pct(e['share'])}' for e in omitted)}. Their energy is still assessed against the limits.")
    classification = kept[0]["sector"] if len(kept) == 1 else "Mixed-Use"
    if not kept:
        reasons.append("No classifiable floor area was supplied.")
    elif classification == "Mixed-Use":
        reasons.append(f"Mixed-Use: {', '.join(f'{e['sector']} {pct(e['share'])}' for e in kept)} (4.2.2 step 4).")
    else:
        reasons.append(f"Single sector: {classification} (4.2.2 step 4).")

    additional = []
    for a in areas:
        label = a.get("additionalUse")
        if not label:
            continue
        sector = a.get("sector")
        permitted = ADDITIONAL_USES_BY_SECTOR.get(sector or "", ())
        listed = any(p.lower() == label.lower() for p in permitted)
        if sector is None:
            reason = "Additional Uses are defined per sector (Table 9); an unclassifiable area cannot claim one."
        elif not listed:
            reason = f'"{label}" is not a Table 9 Additional Use for {sector}. Permitted: {"; ".join(permitted) or "none"}.'
        elif not a.get("submetered"):
            reason = "Additional Uses must be submetered to be exempt from the limits (5.2.1.3)."
        else:
            reason = ""
        additional.append({"label": label, "niaM2": _num(a, "niaM2"), "submetered": bool(a.get("submetered")), "sector": sector, "allowed": reason == "", "reason": reason or "Table 9 Additional Use, submetered."})
    au_nia = sum(u["niaM2"] for u in additional if u["allowed"])
    au_share = round(au_nia / total, 4) if total > 0 else 0.0
    if au_share > ADDITIONAL_USE_NIA_SHARE_LIMIT:
        reasons.append(f"Additional Uses cover {pct(au_share)} of NIA, above the {pct(ADDITIONAL_USE_NIA_SHARE_LIMIT)} cap (5.2.1.3); the excess cannot be exempted from the limits.")

    return {
        "classification": classification, "sectors": kept, "omitted": omitted,
        "unclassifiableShare": round(unclassifiable_share, 4), "canClaim": can_claim,
        "additionalUses": additional, "additionalUseShare": au_share, "totalNiaM2": total, "reasons": reasons,
    }


def limit_sector_for(area: dict[str, Any]) -> dict[str, Any] | None:
    """Table 12: the sector and subsector whose limit a particular use takes."""
    use = area.get("particularUse")
    if use and use in PARTICULAR_USE_LIMIT_SECTOR:
        m = PARTICULAR_USE_LIMIT_SECTOR[use]
        return {"sector": m["sector"], "subsector": m.get("subsector"), "scope": None}
    if area.get("sector") is None:
        return None
    return {"sector": area["sector"], "subsector": area.get("subsector"), "scope": area.get("scope")}


def allowed_additional_use(classification: dict[str, Any], area: dict[str, Any]) -> bool:
    label = area.get("additionalUse")
    if not label:
        return False
    return any(u["label"] == label and u["niaM2"] == _num(area, "niaM2") and u["allowed"] for u in classification["additionalUses"])


# --------------------------------------------------------------------------- #
# region                                                                       #
# --------------------------------------------------------------------------- #


def region_for(nation: str | None = None, county: str | None = None) -> dict[str, Any]:
    """Annex A3: region from the nation and, for England, the county."""
    if nation == "Scotland":
        return {"value": "A. Scotland", "section": "Annex A3", "reasons": ["Scotland."]}
    if nation in ("Wales", "Northern Ireland"):
        return {"value": "B. Middle and North England, Northern Ireland, Wales", "section": "Annex A3", "reasons": [f"{nation}."]}
    if county:
        south = any(c.lower() == county.strip().lower() for c in SOUTH_ENGLAND_COUNTIES)
        if south:
            return {"value": "C. South England", "section": "Annex A3", "reasons": [f"{county} is in the Annex A3 list of South England counties."]}
        if nation == "England":
            return {"value": "B. Middle and North England, Northern Ireland, Wales", "section": "Annex A3", "reasons": [f"{county} is not in the Annex A3 list of South England counties."]}
    return {"value": None, "section": "Annex A3", "reasons": ["Region needs the nation, and for England the county, to be known."]}
