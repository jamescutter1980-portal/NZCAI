"""Smoke tests: the tools are registered and reachable over the protocol layer."""

from pathlib import Path

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from nzcai_mcp.config import Config
from nzcai_mcp.server import build_server

from fixtures.crrem import write_pathways
from fixtures.desnz import write_flat_file

REPO_DATA = Path(__file__).resolve().parent.parent / "data"


@pytest.fixture
def server(tmp_path):
    write_flat_file(tmp_path)
    write_pathways(tmp_path)
    return build_server(
        Config(
            transport="stdio", host="127.0.0.1", port=8080,
            data_dir=REPO_DATA, reference_data_dir=tmp_path,
        )
    )


@pytest.mark.anyio
async def test_expected_tools_are_registered(server):
    names = {tool.name for tool in await server.list_tools()}
    assert names == {
        "calculate_carbon_intensity",
        "crrem_misalignment_year",
        "list_reference_datasets",
        "nzcbs_assess",
        "nzcbs_check",
        "nzcbs_classify",
        "nzcbs_limits",
        "search_emission_factors",
    }


@pytest.mark.anyio
async def test_carbon_tool_cites_the_published_rows_it_used(server):
    result = await server.call_tool(
        "calculate_carbon_intensity",
        {"consumption_kwh": {"electricity": 100_000}, "floor_area_m2": 1_000,
         "reporting_year": 2025},
    )
    assert result.is_error is False
    provenance = result.structured_content["provenance"]
    assert provenance["reporting_year"] == 2025
    electricity = provenance["factors"]["electricity"]
    # Generation plus transmission and distribution, both named by row id.
    assert [r["id"] for r in electricity["rows"]] == ["1001", "2001"]
    assert "DESNZ 2025 row 1001, 2001" in electricity["reference"]


@pytest.mark.anyio
async def test_missing_flat_file_year_reaches_the_caller(server):
    """The SDK hides the text of an unexpected exception, so a wrong argument has
    to come back as a ToolError or the model cannot correct itself."""
    with pytest.raises(ToolError, match=r"No DESNZ 1999 flat file loaded"):
        await server.call_tool(
            "calculate_carbon_intensity",
            {"consumption_kwh": {"electricity": 1.0}, "floor_area_m2": 1.0,
             "reporting_year": 1999},
        )


@pytest.mark.anyio
async def test_fuel_without_a_selector_reaches_the_caller(server):
    with pytest.raises(ToolError, match="no published selector for fuel 'hydrogen'"):
        await server.call_tool(
            "calculate_carbon_intensity",
            {"consumption_kwh": {"hydrogen": 1.0}, "floor_area_m2": 1.0,
             "reporting_year": 2025},
        )


@pytest.mark.anyio
async def test_search_finds_a_row_id_for_an_unselectored_fuel(server):
    result = await server.call_tool(
        "search_emission_factors", {"reporting_year": 2025, "query": "gas oil"})
    rows = result.structured_content["rows"]
    assert [r["id"] for r in rows] == ["4001"]


@pytest.mark.anyio
async def test_list_reports_which_flat_file_years_are_loaded(server):
    result = await server.call_tool("list_reference_datasets", {})
    assert result.structured_content["desnz_conversion_factors"]["years_loaded"] == [2025]


@pytest.mark.anyio
async def test_crrem_tool_cites_the_pathway_version_and_licence(server):
    result = await server.call_tool(
        "crrem_misalignment_year",
        {
            "country_code": "GB",
            "property_type": "Office",
            "asset_series": {"2025": 6.0},
            "floor_area_m2": 2_000,
        },
    )
    payload = result.structured_content
    assert payload["misalignment_year"] == 2025
    assert payload["unit"] == "kgCO2e/m2"
    assert payload["provenance"]["version"] == "vTEST"
    assert payload["provenance"]["basis"] == "modelled"
    assert "CRREM" in payload["provenance"]["attribution"]
    assert "software-use rights" in payload["provenance"]["licence"]


@pytest.mark.anyio
async def test_crrem_tool_reports_an_unknown_property_type(server):
    with pytest.raises(ToolError, match="Loaded property types"):
        await server.call_tool(
            "crrem_misalignment_year",
            {"country_code": "GB", "property_type": "Datacentre",
             "asset_series": {"2025": 6.0}},
        )


@pytest.mark.anyio
async def test_list_reports_both_reference_sets(server):
    payload = (await server.call_tool("list_reference_datasets", {})).structured_content
    assert payload["desnz_conversion_factors"]["years_loaded"] == [2025]
    assert payload["crrem_pathways"]["versions_loaded"] == ["vTEST"]
    assert payload["crrem_pathways"]["newest"]["property_types"] == ["Office", "Retail, High Street"]
    assert payload["uk_nzcbs"]["versions_loaded"] == ["v1r1"]
    assert payload["uk_nzcbs"]["newest"]["source"] == "bundled"
    assert "Offices" in payload["uk_nzcbs"]["newest"]["sectors"]
    assert payload["uk_nzcbs"]["newest"]["tables"] == ["EC-1", "EC-2", "EC-3", "OE-1", "OE-2", "OE-3", "OE-4"]


@pytest.mark.anyio
async def test_nzcbs_check_reports_not_assessable_rather_than_passing(server):
    result = await server.call_tool(
        "nzcbs_check",
        {"sector": "Offices", "subsector": "General", "scope": "Whole building", "year": 2025,
         "asset_values": {"eui": 95.0, "refrigerant_gwp": 2088}},
    )
    payload = result.structured_content
    # EUI 95 against OE-2 2025 Offices 105 passes; the GWP 2088 fails the 677 limit.
    assert payload["counts"] == {"pass": 1, "fail": 1, "not_assessable": 0}
    assert payload["table"] == "OE-2" and payload["limit_year"] == 2025
    missing = await server.call_tool("nzcbs_check", {"sector": "Offices", "subsector": "General", "year": 2025})
    assert missing.structured_content["rows"][0]["status"] == "not_assessable"
    assert "targeting verification" in payload["disclaimer"]


@pytest.mark.anyio
async def test_nzcbs_limits_reads_the_bundled_rev1_tables(server):
    payload = (await server.call_tool(
        "nzcbs_limits", {"table": "OE-2", "sector": "Offices", "subsector": "General", "scope": "Whole building", "year": 2025})).structured_content
    assert payload["status"] == "limit" and payload["value"] == 105 and payload["unit"] == "kWh/m2GIA/yr"
    assert payload["version"] == "v1r1"
    assert "Net Zero Carbon Buildings Standard" in payload["attribution"]
    none = (await server.call_tool("nzcbs_limits", {"table": "OE-4", "sector": "Offices", "subsector": "General", "scope": "Whole building", "year": 2025})).structured_content
    assert none["status"] == "no_limit" and none["value"] is None
    assert any("no numeric limit" in w for w in none["warnings"])


@pytest.mark.anyio
async def test_nzcbs_assess_and_classify_run_the_engine(server):
    profile = {
        "rpep": "2027-03-31", "giaM2": 5000, "niaM2": 4000, "footprintM2": 1000, "region": "C. South England",
        "areas": [{"sector": "Offices", "subsector": "General", "scope": "Whole building", "niaM2": 4000, "giaM2": 5000}],
    }
    classified = (await server.call_tool("nzcbs_classify", {"profile": profile})).structured_content
    assert classified["buildingType"]["value"] == "Existing Building"
    assert classified["operationalEnergyLimit"]["value"] == 105
    assessed = (await server.call_tool("nzcbs_assess", {
        "profile": profile,
        "inputs": {"energy": {"supplies": [{"kind": "grid_electricity", "kwh": 400000}], "gridFactors": {"generation": 0.2, "transmissionAndDistribution": 0.02, "wttGeneration": 0.05, "wttTransmissionAndDistribution": 0.005}}},
    })).structured_content
    oe = next(a for a in assessed["aspects"] if a["aspect"] == "operational_energy")
    eui = next(f for f in oe["findings"] if f["id"] == "oe.eui")
    assert eui["status"] == "pass" and eui["value"] == 80 and eui["limit"] == 105
    assert "targeting verification" in assessed["permittedStatement"]
    with pytest.raises(ToolError, match="rpep"):
        await server.call_tool("nzcbs_assess", {"profile": {"giaM2": 1, "niaM2": 1, "areas": [{"sector": "Offices", "niaM2": 1}]}})


@pytest.fixture
def anyio_backend():
    return "asyncio"
