"""Smoke tests: the tools are registered and reachable over the protocol layer."""

from pathlib import Path

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from nzcai_mcp.config import Config
from nzcai_mcp.server import build_server

REPO_DATA = Path(__file__).resolve().parent.parent / "data"


@pytest.fixture
def server():
    return build_server(Config(transport="stdio", host="127.0.0.1", port=8080, data_dir=REPO_DATA))


@pytest.mark.anyio
async def test_expected_tools_are_registered(server):
    names = {tool.name for tool in await server.list_tools()}
    assert names == {
        "calculate_carbon_intensity",
        "crrem_misalignment_year",
        "list_reference_datasets",
    }


@pytest.mark.anyio
async def test_carbon_tool_attaches_provenance(server):
    result = await server.call_tool(
        "calculate_carbon_intensity",
        {"consumption_kwh": {"electricity": 100_000}, "floor_area_m2": 1_000},
    )
    assert result.is_error is False
    provenance = result.structured_content["provenance"]
    assert provenance["dataset"] == "factors/example-uk"
    assert provenance["verified"] is False
    assert "warning" in provenance


@pytest.mark.anyio
async def test_unknown_dataset_error_names_the_available_datasets(server):
    """The SDK hides the text of an unexpected exception, so a wrong argument has
    to come back as a ToolError or the model cannot correct itself."""
    with pytest.raises(ToolError, match="available: example-uk"):
        await server.call_tool(
            "calculate_carbon_intensity",
            {
                "consumption_kwh": {"electricity": 1.0},
                "floor_area_m2": 1.0,
                "factor_set": "does-not-exist",
            },
        )


@pytest.mark.anyio
async def test_calculation_failure_reaches_the_caller(server):
    with pytest.raises(ToolError, match="no emission factor for hydrogen"):
        await server.call_tool(
            "calculate_carbon_intensity",
            {"consumption_kwh": {"hydrogen": 1.0}, "floor_area_m2": 1.0},
        )


@pytest.mark.anyio
async def test_crrem_tool_returns_projection(server):
    result = await server.call_tool(
        "crrem_misalignment_year",
        {
            "baseline_intensity_kgco2e_per_m2": 60.0,
            "baseline_year": 2025,
            "floor_area_m2": 2_000,
        },
    )
    payload = result.structured_content
    assert payload["misalignment_year"] == 2025
    assert payload["cumulative_excess_tco2e"] > 0
    assert payload["provenance"]["verified"] is False


@pytest.fixture
def anyio_backend():
    return "asyncio"
