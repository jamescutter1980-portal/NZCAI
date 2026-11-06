"""UK NZCBS V1 Rev 1: the bundled tables, the shared vectors and the check tool."""

import json

import pytest

from nzcai_mcp import nzcbs as ref_mod
from nzcai_mcp.nzcbs import (
    NzcbsDataError,
    clamp_limit_year,
    contains_prohibited_claim,
    demand_statistics,
    equation_1a,
    equation_1b,
    equation_5,
    find_limit,
    grid_factor,
    leakage_kg,
    list_versions,
    load_reference,
    network_carbon_factor,
    network_energy_use,
    network_limit,
    occupancy_rate,
    other_limit,
    refrigerant_charge_kgco2e,
    renewables_target,
    works_type,
)
from nzcai_mcp.tools.nzcbs import check

from fixtures.nzcbs import VECTORS, tampered_copy

vectors = json.loads(VECTORS.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def ref(tmp_path_factory):
    # An empty deployment directory: only the bundled tables are visible.
    return load_reference(tmp_path_factory.mktemp("empty"), vectors["version"])


# --------------------------------------------------------------------------- #
# loading                                                                      #
# --------------------------------------------------------------------------- #


def test_bundled_tables_load_with_checksums(ref):
    assert ref is not None
    assert ref.version == "v1r1" and ref.bundled
    assert len(ref.limits) == ref.manifest["files"]["limits.csv"]["rows"]
    assert len(ref.sectors) == 13
    assert ref.menus["Which works type are you reporting?"] == ["New Works", "Retrofit Works", "Reportable Works", "no works to be reported"]


def test_unknown_version_is_none_not_an_error(tmp_path):
    assert load_reference(tmp_path, "v0.0") is None
    assert [v.version for v in list_versions(tmp_path)] == ["v1r1"]


def test_edited_table_is_refused(tmp_path):
    tampered_copy(tmp_path)
    ref_mod.clear_cache()
    assert [v.version for v in list_versions(tmp_path)] == ["v9test", "v1r1"]
    with pytest.raises(NzcbsDataError, match="does not match its manifest checksum"):
        load_reference(tmp_path, "v9test")


# --------------------------------------------------------------------------- #
# the shared vectors                                                           #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("case", vectors["limits"], ids=lambda c: c["note"][:70])
def test_annex_a_lookups(ref, case):
    res = find_limit(
        ref, table=case["table"], sector=case["sector"], year=case["year"],
        subsector=case.get("subsector"), scope=case.get("scope"), area_basis=case.get("areaBasis"),
    )
    assert res.status == case["expect"]["status"]
    assert res.value == case["expect"]["value"]
    if "unit" in case["expect"]:
        assert res.unit == case["expect"]["unit"]
    if "year" in case["expect"]:
        assert res.year == case["expect"]["year"]


def test_annex_a3_and_a4(ref):
    for v in vectors["renewables_targets"]:
        assert renewables_target(ref, v["region"], v["group"]).value == v["expect"]
    for key, value in vectors["other_limits"].items():
        assert other_limit(ref, key).value == value


def test_equations():
    for v in vectors["equation_1a"]:
        assert equation_1a([(p["share"], p["limit"]) for p in v["parts"]]) == v["expect"]
    for v in vectors["equation_1b"]:
        assert equation_1b(v["newShare"], v["ln"], v["le"]) == v["expect"]
    for v in vectors["equation_5"]:
        assert equation_5(v["target"], v["unconstrainedAreaM2"], v["footprintM2"]) == v["expect"]
    for v in vectors["equation_4"]:
        assert occupancy_rate(v["totalGiaM2"], v["unoccupiableGiaM2"], v["occupiedGiaM2"]) == v["expect"]
    for v in vectors["grid_factor"]:
        assert grid_factor(v["generation"], v["transmissionAndDistribution"], v["wttGeneration"], v["wttTransmissionAndDistribution"]) == v["expect"]
    for v in vectors["dhcn_limits"]:
        assert abs(network_limit(v["service"], v["existing"], v["gridFactor"])["value"] - v["expect"]) <= v["tolerance"]
    for v in vectors["equation_2"]:
        assert network_energy_use(v["generationInputKwh"], v["distributionInputKwh"], v["meteredKwh"], v["systemDeliveredKwh"]) == v["expectEnergyUseKwh"]
        assert network_carbon_factor(v["generationKgCo2e"], v["distributionKgCo2e"], v["systemDeliveredKwh"]) == v["expectFactor"]
    for v in vectors["refrigerants"]:
        assert refrigerant_charge_kgco2e(v["systems"]) == v["expectChargeKgCo2e"]
        for e in v["expectLeakage"]:
            system = next(s for s in v["systems"] if s["id"] == e["id"])
            assert leakage_kg(system) == (e["kg"], e["equation"])
        kyoto = sum((leakage_kg(s)[0] or 0) * s["gwp"] for s in v["systems"])
        assert round(kyoto, 1) == v["expectKyotoLeakageKgCo2e"]
        assert [s["id"] for s in v["systems"] if s["gwp"] > vectors["other_limits"]["refrigerant_gwp_limit"]] == v["expectGwpFails"]
    for v in vectors["demand"]:
        s = demand_statistics(v["intervalKwh"], v["resolutionMinutes"])
        assert s["top_ten_kw"] == v["expectTopTenKw"]
        assert s["p50_kw"] == v["expectP50Kw"] and s["p1_kw"] == v["expectP1Kw"]
    for v in vectors["works_type"]:
        assert works_type(v["facts"]) == v["expect"]
    for t in vectors["prohibited_claims"]["prohibited"]:
        assert contains_prohibited_claim(t), t
    for t in vectors["prohibited_claims"]["permitted"]:
        assert not contains_prohibited_claim(t), t


def test_year_clamp():
    assert clamp_limit_year(2019) == 2025
    assert clamp_limit_year(2060) == 2050
    assert clamp_limit_year(2031) == 2031


# --------------------------------------------------------------------------- #
# the check tool                                                               #
# --------------------------------------------------------------------------- #


def run_check(ref, **kw):
    defaults = dict(sector="Offices", year=2025, asset_values={}, loaded_versions=["v1r1"], requested_version=None, deployment_dir="/data/reference/uk-nzcbs", bundled_dir="/app/reference/uk-nzcbs")
    defaults.update(kw)
    return check(ref, **defaults)


def test_existing_office_one_go_uses_oe2_2025(ref):
    r = run_check(ref, subsector="General", scope="Whole building", asset_values={"eui": 95})
    assert r["assessable"] and r["table"] == "OE-2" and r["limit_year"] == 2025
    eui = r["rows"][0]
    assert eui["status"] == "pass" and eui["limit_value"] == 105 and eui["gap"] == -10
    assert r["counts"] == {"pass": 1, "fail": 0, "not_assessable": 0}
    assert "targeting verification" in r["summary"]
    assert "aligned" not in r["summary"].lower()


def test_new_building_and_stepped_route_select_their_tables(ref):
    new = run_check(ref, building_type="New Building", subsector="General", scope="Whole building", asset_values={"eui": 95})
    assert new["table"] == "OE-1" and new["rows"][0]["limit_value"] == 90 and new["rows"][0]["status"] == "fail"
    stepped = run_check(ref, route="stepped", subsector="General", scope="Whole building", year=2026, asset_values={"eui": 120})
    assert stepped["table"] == "OE-3"
    assert stepped["rows"][0]["year"] == 2026
    assert any("Retrofit Plan" in w for w in stepped["warnings"])


def test_nia_basis_for_offices(ref):
    r = run_check(ref, subsector="General", scope="Whole building", area_basis="NIA", asset_values={"eui": 120})
    assert r["rows"][0]["limit_value"] == 131 and r["rows"][0]["unit"] == "kWh/m2NIA/yr"


def test_ambiguous_office_is_not_assessable_not_guessed(ref):
    r = run_check(ref, asset_values={"eui": 95})
    assert r["rows"][0]["status"] == "not_assessable"
    assert "more than one limit fits" in r["rows"][0]["reason"]


def test_missing_value_is_not_assessable_never_a_pass(ref):
    r = run_check(ref, subsector="General", scope="Whole building")
    assert r["rows"][0] ["status"] == "not_assessable" and r["rows"][0]["limit_value"] == 105
    assert any("never as a pass" in w for w in r["warnings"])


def test_other_metrics(ref):
    r = run_check(
        ref, subsector="General", scope="Whole building", works_type="Retrofit Works", region="C. South England",
        asset_values={"eui": 95, "upfront_carbon": 400, "renewables_per_footprint": 50, "refrigerant_gwp": 2088, "pv_upfront_carbon_per_kwp": 900, "mystery": 1},
    )
    by = {row["metric"]: row for row in r["rows"]}
    ec2_2025_offices = next(x for x in ref.limits if x.table == "EC-2" and x.sector == "Offices" and x.subsector == "General" and x.scope == "Whole building" and x.year == 2025)
    assert by["Upfront carbon (Retrofit Works)"]["limit_value"] == ec2_2025_offices.value
    assert by["Annual on-site renewable electricity generation per m2 footprint"] ["status"] == "pass"
    assert by["Annual on-site renewable electricity generation per m2 footprint"]["limit_value"] == 45
    assert by["GWP of refrigerant"]["status"] == "fail" and by["GWP of refrigerant"]["limit_value"] == 677
    assert by["PV upfront carbon per kWp"]["status"] == "pass" and "proforma prints 750" in by["PV upfront carbon per kWp"]["reason"]
    assert by["mystery"]["status"] == "not_assessable"


def test_space_heating_only_for_new_homes(ref):
    flats = run_check(ref, sector="Homes", subsector="Flats", building_type="New Building", asset_values={"space_heating": 12})
    sh = next(row for row in flats["rows"] if row["metric"].startswith("Annual space heating"))
    assert sh["status"] == "pass" and sh["limit_value"] == 15
    existing = run_check(ref, sector="Homes", subsector="Flats", asset_values={"space_heating": 12})
    sh2 = next(row for row in existing["rows"] if row["metric"].startswith("Annual space heating"))
    assert sh2["status"] == "not_assessable"


def test_no_tables_and_unknown_sector_are_reported(ref):
    none = run_check(None, loaded_versions=[])
    assert none["assessable"] is False and "No UK NZCBS reference tables" in none["reasons"][0]
    bad = run_check(ref, sector="Airship hangar")
    assert bad["assessable"] is False and "not a Table 6 sector" in bad["summary"]
