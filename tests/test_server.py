"""Smoke tests: the tools are registered and reachable over the protocol layer."""

from pathlib import Path

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from nzcai_mcp.config import Config
from nzcai_mcp.server import build_server

from fixtures.crrem import write_pathways
from fixtures.nzcbs import write_limits
from fixtures.desnz import write_flat_file

REPO_DATA = Path(__file__).resolve().parent.parent / "data"


@pytest.fixture
def server(tmp_path):
    write_flat_file(tmp_path)
    write_pathways(tmp_path)
    write_limits(tmp_path)
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
        "nzcbs_check",
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
    assert payload["uk_nzcbs"]["versions_loaded"] == ["vTEST"]
    assert payload["uk_nzcbs"]["newest"]["sectors"] == ["Office", "Retail"]


@pytest.mark.anyio
async def test_nzcbs_check_reports_not_assessable_rather_than_passing(server):
    result = await server.call_tool(
        "nzcbs_check",
        {"sector": "Office", "year": 2025, "asset_values": {"operational_energy_eui": 95.0}},
    )
    payload = result.structured_content
    assert payload["counts"] == {"pass": 1, "fail": 0, "not_assessable": 2}
    assert "not a verified NZCBS assessment" in payload["disclaimer"]


@pytest.mark.anyio
async def test_nzcbs_limits_flags_rows_with_no_limit(server):
    payload = (await server.call_tool(
        "nzcbs_limits", {"sector": "Office", "year": 2025})).structured_content
    unavailable = [r for r in payload["rows"] if r["availability"] == "unavailable"]
    assert [r["metric"] for r in unavailable] == ["onsite_renewables"]
    assert any("not 0" in w for w in payload["warnings"])
    assert "UK NZCBS" in payload["attribution"]


@pytest.fixture
def anyio_backend():
    return "asyncio"
