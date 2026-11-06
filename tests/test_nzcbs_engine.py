"""Scenario tests for the UK NZCBS V1 Rev 1 engine on the bundled tables.

Buildings and figures are invented; every limit they are compared with is the
published one, read from the tables and cross-checked against the Standard's
text in test_nzcbs.py.
"""

import pytest

from nzcai_mcp.nzcbs import (
    NzcbsInputError,
    assess_building,
    classify_building,
    classify_building_profile,
    classify_sectors,
    load_reference,
    operational_limit_year,
    region_for,
    reporting_periods,
    resolve_limits,
)

GRID = {"generation": 0.2, "transmissionAndDistribution": 0.02, "wttGeneration": 0.05, "wttTransmissionAndDistribution": 0.005, "reference": "synthetic"}


@pytest.fixture(scope="module")
def ref(tmp_path_factory):
    return load_reference(tmp_path_factory.mktemp("empty"), "v1r1")


def office(**over):
    p = {
        "rpep": "2027-03-31", "giaM2": 5000, "niaM2": 4000, "footprintM2": 1000, "region": "C. South England",
        "areas": [{"sector": "Offices", "subsector": "General", "scope": "Whole building", "niaM2": 4000, "giaM2": 5000}],
    }
    p.update(over)
    return p


def aspect(result, name):
    return next(a for a in result["aspects"] if a["aspect"] == name)


def finding(result, aspect_name, fid):
    return next(f for f in aspect(result, aspect_name)["findings"] if f["id"] == fid)


INPUTS = {
    "energy": {
        "supplies": [
            {"kind": "grid_electricity", "kwh": 400_000, "measurement": "meter_readings"},
            {"kind": "onsite_renewable_electricity_used", "kwh": 50_000, "measurement": "meter_readings"},
            {"kind": "natural_gas", "kwh": 60_000, "factorKgCo2ePerKwh": 0.21, "measurement": "meter_readings"},
            {"kind": "grid_electricity", "kwh": 20_000, "excluded": "car_park_submetered"},
        ],
        "gridFactors": GRID,
        "occupancy": {"totalGiaM2": 5000, "unoccupiableGiaM2": 500, "occupiedGiaM2": 4000},
    },
    "renewables": {"systems": [{"technology": "photovoltaics", "capacityKw": 60, "generatedKwh": 55_000, "exportedKwh": 5_000}]},
    "fossilFuels": {"systems": [{"description": "Gas boilers", "fuel": "natural_gas"}]},
    "refrigerants": {"systems": [{"id": "VRF-1", "systemType": "VRF", "refrigerant": "R-410A", "gwp": 2088, "chargeKg": 20, "addedKg": 0, "installDate": "2024-01-01", "exception": "installed_before_v1_no_works"}]},
    "demand": {"giaM2": 5000, "resolutionMinutes": 30, "intervalKwh": [10 + (30 if i % 48 < 20 else 0) for i in range(17_520)]},
    "water": {"sources": [{"source": "network", "m3": 3000, "supplyFactorKgCo2ePerM3": 0.15}], "treatmentFactorKgCo2ePerM3": 0.27},
}


# --------------------------------------------------------------------------- #
# periods, limit year, classification                                          #
# --------------------------------------------------------------------------- #


def test_reporting_periods():
    p = reporting_periods({"rpep": "2027-03-31"})
    assert p["orp"] == {"from": "2026-03-31", "to": "2027-03-31"}
    assert p["erp"]["from"] == "2022-03-31" and p["orpStartYear"] == 2026
    gap = reporting_periods({"rpep": "2027-03-31", "previousRpep": "2025-09-30"})
    assert gap["erp"]["from"] == "2025-09-30"
    assert "gap in claim validity" in " ".join(gap["reasons"])


def test_operational_limit_year_rules():
    p = office()
    assert operational_limit_year(p, "Existing Building", reporting_periods(p))["year"] == 2025
    p = office(works=[{"id": "R1", "type": "Retrofit Works", "commencementDate": "2028-05-01", "completionDate": "2029-01-01"}])
    assert operational_limit_year(p, "Existing Building", reporting_periods(p))["year"] == 2028
    p = office(operationalRoute="stepped", rpep="2031-01-01")
    assert operational_limit_year(p, "Existing Building", reporting_periods(p))["year"] == 2030
    p = office(works=[{"id": "N1", "type": "New Works", "commencementDate": "2023-01-01"}], previouslyClassifiedNewBuilding=True)
    assert operational_limit_year(p, "New Building", reporting_periods(p))["year"] == 2025


def test_classification_rules():
    assert classify_building(office(areas=[{"sector": "Offices", "subsector": "General", "niaM2": 2000, "newArea": True}, {"sector": "Offices", "subsector": "General", "niaM2": 2000}]))["value"] == "New Building"
    c = classify_sectors(office(areas=[{"sector": "Offices", "subsector": "General", "niaM2": 3000}, {"sector": "Retail", "subsector": "High St. Retail", "niaM2": 300}, {"sector": None, "niaM2": 700}]))
    assert c["canClaim"] and [s["sector"] for s in c["omitted"]] == ["Retail"] and c["classification"] == "Offices"
    assert classify_sectors(office(areas=[{"sector": "Offices", "niaM2": 2800}, {"sector": None, "niaM2": 1200}]))["canClaim"] is False
    assert classify_sectors(office(areas=[{"sector": "Offices", "subsector": "General", "niaM2": 2400}, {"sector": "Retail", "subsector": "High St. Retail", "niaM2": 1600}]))["classification"] == "Mixed-Use"
    hotel = classify_sectors(office(areas=[{"sector": "Hotels", "niaM2": 3600}, {"sector": "Hotels", "niaM2": 200, "additionalUse": "Laundry", "submetered": True}, {"sector": "Hotels", "niaM2": 200, "additionalUse": "Laundry", "submetered": False}]))
    assert [u["allowed"] for u in hotel["additionalUses"]] == [True, False]
    wrong = classify_sectors(office(areas=[{"sector": "Offices", "subsector": "General", "niaM2": 3800}, {"sector": "Offices", "niaM2": 200, "additionalUse": "Laundry", "submetered": True}]))
    assert wrong["additionalUses"][0]["allowed"] is False and "not a Table 9 Additional Use" in wrong["additionalUses"][0]["reason"]
    with pytest.raises(NzcbsInputError, match="not a Table 6 sector"):
        classify_sectors(office(areas=[{"sector": "Airship", "niaM2": 1}]))


def test_region_for():
    assert region_for("England", "Kent")["value"] == "C. South England"
    assert region_for("England", "Greater Manchester")["value"].startswith("B.")
    assert region_for("Scotland")["value"] == "A. Scotland"
    assert region_for()["value"] is None


# --------------------------------------------------------------------------- #
# limit selection                                                              #
# --------------------------------------------------------------------------- #


def test_single_sector_existing_office_limit(ref):
    ctx = resolve_limits(ref, office())
    oe = ctx["operationalEnergy"]
    assert (oe["status"], oe["value"], oe["unit"], oe["table"], oe["year"], oe["method"]) == ("limit", 105, "kWh/m2GIA/yr", "OE-2", 2025, "single")
    nia = resolve_limits(ref, office(areaBasis="NIA"))["operationalEnergy"]
    assert (nia["value"], nia["unit"], nia["areaBasis"]) == (131, "kWh/m2NIA/yr", "NIA")


def test_equation_1a_across_offices_and_a_shop(ref):
    p = office(previouslyClassifiedNewBuilding=True, areas=[{"sector": "Offices", "subsector": "General", "scope": "Whole building", "niaM2": 2400}, {"sector": "Retail", "subsector": "High St. Retail", "niaM2": 1600}])
    oe = resolve_limits(ref, p)["operationalEnergy"]
    assert (oe["status"], oe["value"], oe["method"], oe["table"]) == ("limit", 86, "equation_1a", "OE-1")


def test_equation_1a_omits_additional_uses_and_data_centres(ref):
    p = office(previouslyClassifiedNewBuilding=True, areas=[
        {"sector": "Offices", "subsector": "General", "scope": "Whole building", "niaM2": 2400},
        {"sector": "Data Centres", "subsector": "Low Utilisation", "niaM2": 800},
        {"sector": "Offices", "subsector": "General", "niaM2": 800, "additionalUse": "Laundry", "submetered": True},
    ])
    oe = resolve_limits(ref, p)["operationalEnergy"]
    assert oe["value"] == 90 and "Data Centre area" in " ".join(oe["notes"])


def test_equation_1b_for_thirty_percent_new_area(ref):
    p = office(areas=[
        {"sector": "Offices", "subsector": "General", "scope": "Whole building", "niaM2": 1200, "giaM2": 1500, "newArea": True},
        {"sector": "Offices", "subsector": "General", "scope": "Whole building", "niaM2": 2800, "giaM2": 3500},
    ], works=[{"id": "N1", "type": "New Works", "commencementDate": "2025-06-01", "completionDate": "2026-06-01"}])
    oe = resolve_limits(ref, p)["operationalEnergy"]
    assert (oe["status"], oe["value"], oe["method"]) == ("limit", 96, "equation_1b")


def test_table_12_reclassifies_a_gym_for_limit_setting(ref):
    p = office(previouslyClassifiedNewBuilding=True, areas=[{"sector": "Offices", "subsector": "General", "scope": "Whole building", "niaM2": 3200}, {"sector": "Offices", "niaM2": 800, "particularUse": "gym"}])
    ctx = resolve_limits(ref, p)
    assert ctx["sectors"]["classification"] == "Offices"
    assert ctx["operationalEnergy"]["method"] == "equation_1a"
    assert [c["sector"] for c in ctx["operationalEnergy"]["components"]] == ["Offices", "Sport and Leisure"]


def test_embodied_limit_selection(ref):
    p = office(works=[
        {"id": "R1", "type": "Retrofit Works", "commencementDate": "2026-09-01", "completionDate": "2027-01-15", "embodied": {"upfrontKgCo2e": 1_000_000, "giaM2": 5000}},
        {"id": "R0", "type": "Retrofit Works", "commencementDate": "2025-01-01", "completionDate": "2025-12-01", "embodied": {"upfrontKgCo2e": 500_000, "giaM2": 5000}},
    ])
    emb = {e["worksId"]: e for e in resolve_limits(ref, p)["embodied"]}
    assert emb["R1"]["compare"] and emb["R1"]["table"] == "EC-2" and emb["R1"]["year"] == 2026 and emb["R1"]["status"] == "limit"
    assert emb["R0"]["compare"] is False


def test_renewables_target_reductions(ref):
    t = resolve_limits(ref, office(), {"systems": [], "constraints": {"unconstrainedAreaM2": 500, "reasons": ["overshadowed_roofs"]}})["renewables"]
    assert (t["baseTarget"], t["target"], t["applies"]) == (45, 22.5, True)
    assert resolve_limits(ref, office(), {"systems": [], "feasibleCapacityKwp": 3})["renewables"]["applies"] is False
    storage = office(singleStorey=True, areas=[{"sector": "Storage and Distribution", "subsector": "Unconditioned Storage", "scope": "Whole building", "niaM2": 4000}])
    assert resolve_limits(ref, storage)["renewables"]["baseTarget"] == 75


def test_space_heating_limit_only_for_new_homes(ref):
    flats = office(previouslyClassifiedNewBuilding=True, areas=[{"sector": "Homes", "subsector": "Flats", "niaM2": 4000}])
    sh = resolve_limits(ref, flats)["spaceHeating"]
    assert (sh["status"], sh["value"]) == ("limit", 15)
    assert resolve_limits(ref, office())["spaceHeating"]["status"] == "no_limit"


def test_ambiguous_office_is_reported_not_guessed(ref):
    oe = resolve_limits(ref, office(areas=[{"sector": "Offices", "niaM2": 4000}]))["operationalEnergy"]
    assert oe["status"] == "not_assessable" and "more than one limit fits" in " ".join(oe["notes"])


# --------------------------------------------------------------------------- #
# assess_building                                                              #
# --------------------------------------------------------------------------- #


def test_existing_office_on_the_standards_basis(ref):
    a = assess_building(ref, office(), INPUTS)
    assert (a["buildingType"], a["classification"], a["limitYear"]) == ("Existing Building", "Offices", 2025)
    eui = finding(a, "operational_energy", "oe.eui")
    # (400,000 + 50,000 + 60,000) / 5,000 = 102 against 105. Export and the car park are out.
    assert (eui["status"], eui["value"], eui["limit"], eui["unit"]) == ("pass", 102, 105, "kWh/m2GIA/yr")
    # 400,000 x 0.275 + 0 + 60,000 x 0.21 = 122,600 over 5,000 m2
    assert finding(a, "operational_energy", "oe.carbon_intensity")["value"] == 24.52
    assert finding(a, "operational_energy", "oe.occupancy")["status"] == "pass"


def test_fossil_fuel_free_outcomes(ref):
    assert aspect(assess_building(ref, office(), INPUTS), "fossil_fuel_free")["status"] == "fail"
    with_exception = {**INPUTS, "fossilFuels": {"systems": [{"description": "Standby generator", "fuel": "oil", "exception": "emergency_and_life_safety"}, {"description": "Gas boilers", "fuel": "natural_gas", "exception": "excluded_from_operational_scope"}]}}
    assert aspect(assess_building(ref, office(), with_exception), "fossil_fuel_free")["status"] == "pass"
    undeclared = assess_building(ref, office(), {**INPUTS, "fossilFuels": {"systems": []}})
    assert finding(undeclared, "fossil_fuel_free", "ff.supply.natural_gas")["status"] == "fail"


def test_renewables_target_met(ref):
    a = assess_building(ref, office(), INPUTS)
    t = finding(a, "onsite_renewables", "re.target")
    assert (t["status"], t["value"], t["limit"]) == ("pass", 55, 45)
    assert finding(a, "onsite_renewables", "re.used")["value"] == 50_000


def test_refrigerant_exception_and_leakage(ref):
    a = assess_building(ref, office(), INPUTS)
    assert finding(a, "refrigerants", "rf.gwp.VRF-1")["status"] == "pass"
    assert finding(a, "refrigerants", "rf.leak_detection.VRF-1")["status"] == "not_assessable"
    assert finding(a, "refrigerants", "rf.charge")["value"] == 41_760
    assert finding(a, "refrigerants", "rf.leakage_kyoto")["value"] == 0
    later = assess_building(ref, office(rpep="2030-06-30"), INPUTS)
    assert finding(later, "refrigerants", "rf.gwp.VRF-1")["status"] == "fail"


def test_demand_and_water(ref):
    a = assess_building(ref, office(), INPUTS)
    assert finding(a, "electricity_demand_management", "dm.top_ten")["value"] == 80
    assert finding(a, "electricity_demand_management", "dm.p1")["value"] == 20
    assert aspect(a, "operational_water")["status"] == "reported"
    assert finding(a, "operational_water", "wa.carbon_per_gia")["value"] == 0.252


def test_no_inputs_is_not_assessable_never_a_pass(ref):
    a = assess_building(ref, office())
    assert a["status"] == "not_assessable"
    assert not [f for asp in a["aspects"] for f in asp["findings"] if f["kind"] == "pass_fail" and f["status"] == "pass"]
    eui = finding(a, "operational_energy", "oe.eui")
    assert eui["status"] == "not_assessable" and eui["limit"] == 105
    assert a["permittedStatement"] == "targeting verification to the UK Net Zero Carbon Buildings Standard"
    assert "aligned" not in a["disclaimer"].lower().replace("net zero carbon aligned", "")


def test_data_centre_pue(ref):
    dc = office(previouslyClassifiedNewBuilding=True, intendedToBeOccupied=False, areas=[{"sector": "Data Centres", "subsector": "Low Utilisation", "niaM2": 4000}])
    a = assess_building(ref, dc, {"energy": {"supplies": [{"kind": "grid_electricity", "kwh": 1_500_000, "dataCentre": True}], "gridFactors": GRID, "itEnergyKwh": 1_000_000, "occupancy": {"totalGiaM2": 5000, "unoccupiableGiaM2": 0, "occupiedGiaM2": 0, "operationalOnFirstDay": True}}})
    pue = finding(a, "operational_energy", "oe.pue")
    assert (pue["status"], pue["value"], pue["limit"]) == ("fail", 1.5, 1.4)


def test_embodied_carbon_against_ec2_and_ec5(ref):
    p = office(works=[{"id": "R1", "type": "Retrofit Works", "commencementDate": "2026-09-01", "completionDate": "2027-01-15", "embodied": {"upfrontKgCo2e": 2_000_000, "giaM2": 5000, "pvKwp": 60, "pvUpfrontKgCo2e": 54_000}}])
    a = assess_building(ref, p)
    up = finding(a, "embodied_carbon", "ec.R1.upfront")
    expected = next(x for x in ref.limits if x.table == "EC-2" and x.sector == "Offices" and x.subsector == "General" and x.scope == "Whole building" and x.year == 2026).value
    assert up["limit"] == expected and up["value"] == 400
    pv = finding(a, "embodied_carbon", "ec.R1.pv")
    assert (pv["status"], pv["value"], pv["limit"]) == ("pass", 900, 1000)
    assert "proforma prints 750" in pv["reason"]


def test_district_network_existing_fossil(ref):
    a = assess_building(ref, office(), {"districtNetworks": {"gridFactorKgCo2ePerKwh": 0.275, "networks": [{"name": "Town heat", "service": "heating", "existing": True, "meteredKwh": 50_000, "systemDeliveredKwh": 1_000_000, "generationInputKwh": 1_200_000, "distributionInputKwh": 60_000, "generationKgCo2e": 200_000, "distributionKgCo2e": 10_000, "suppliesFossilHeat": True}]}})
    cc = finding(a, "district_networks", "dh.town_heat.carbon_content")
    assert cc["status"] == "fail" and cc["value"] == 0.21
    assert finding(a, "district_networks", "dh.town_heat.fossil_plan")["status"] == "not_assessable"


def test_offsets(ref):
    a = assess_building(ref, office(), {"offsets": {"inScopeEmissionsKgCo2e": 120_000, "credits": [{"scheme": "ICVCM", "vintageYear": 2024, "tonnesCo2e": 120, "retired": True, "registryReference": "VCS-1"}, {"scheme": "other", "vintageYear": 2024, "tonnesCo2e": 50, "retired": True}]}})
    assert finding(a, "carbon_offsetting", "of.quantity")["status"] == "pass"
    assert [f["status"] for f in aspect(a, "carbon_offsetting")["findings"] if f["id"].startswith("of.credit")] == ["pass", "fail"]


def test_classify_profile_tool_shape(ref):
    c = classify_building_profile(ref, office())
    assert c["buildingType"]["value"] == "Existing Building"
    assert c["operationalEnergyLimit"]["value"] == 105
    assert c["renewablesTarget"]["baseTarget"] == 45
    with pytest.raises(NzcbsInputError, match="areas"):
        classify_building_profile(ref, {"rpep": "2027-01-01", "giaM2": 1, "niaM2": 1, "areas": []})
