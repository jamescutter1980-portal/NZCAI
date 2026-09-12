"""MCP server definition: wires the domain tools to the protocol.

This module is the only place that imports the MCP SDK. The calculations in
``nzcai_mcp.tools`` stay pure, so they can be reused by the web app or a batch
job without a server in the loop.
"""

from __future__ import annotations

import functools
import logging
import sys
from collections.abc import Callable
from typing import Annotated, Any, TypeVar

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import Field
from starlette.requests import Request
from starlette.responses import JSONResponse

from .config import Config, load_config
from .datasets import DatasetError, get_dataset, list_datasets
from .tools import carbon, crrem
from .tools.carbon import CalculationError

logger = logging.getLogger(__name__)

F = TypeVar("F", bound=Callable[..., Any])

# Failures the caller can act on: a missing dataset, an out-of-range input. The SDK
# withholds the text of any other exception from the client and reports a bare
# "Error executing tool", so these are re-raised as ToolError to keep the detail --
# the model needs to read "available: example-uk" to correct its own argument.
EXPECTED_FAILURES = (DatasetError, CalculationError)


def _report_expected_failures(fn: F) -> F:
    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return fn(*args, **kwargs)
        except EXPECTED_FAILURES as exc:
            raise ToolError(str(exc)) from exc

    return wrapper  # type: ignore[return-value]

INSTRUCTIONS = """\
Tools for UK/EU building energy and carbon analysis.

Every result that depends on reference data carries a `provenance` block naming the
dataset it came from. If `provenance.verified` is false the numbers are placeholder
data and must not be issued to a client.
"""


def build_server(config: Config | None = None) -> MCPServer:
    config = config or load_config()
    server = MCPServer(
        name="nzcai",
        title="NZC / ESG AI",
        version="0.1.0",
        instructions=INSTRUCTIONS,
    )

    @server.tool(
        title="Calculate carbon intensity",
        description=(
            "Convert annual metered consumption into emissions and floor-area "
            "intensities (EUI and kgCO2e/m2), with dual location-based and "
            "market-based Scope 2 reporting when a supplier factor is supplied."
        ),
    )
    @_report_expected_failures
    def calculate_carbon_intensity(
        consumption_kwh: Annotated[
            dict[str, float],
            Field(description="Annual kWh by fuel, e.g. {'electricity': 250000, 'natural_gas': 480000}"),
        ],
        floor_area_m2: Annotated[float, Field(gt=0, description="Gross internal area in m2")],
        factor_set: Annotated[
            str, Field(description="Name of the emission factor dataset to apply")
        ] = "example-uk",
        market_based_electricity_factor: Annotated[
            float | None,
            Field(
                default=None,
                ge=0,
                description="Supplier-specific electricity factor in kgCO2e/kWh for market-based Scope 2",
            ),
        ] = None,
    ) -> dict[str, Any]:
        dataset = get_dataset(config.data_dir, "factors", factor_set)
        result = carbon.calculate_carbon_intensity(
            consumption_kwh=consumption_kwh,
            floor_area_m2=floor_area_m2,
            factors_kgco2e_per_kwh=dataset.values,
            market_based_electricity_factor=market_based_electricity_factor,
        )
        result["provenance"] = dataset.citation()
        return result

    @server.tool(
        title="CRREM misalignment year",
        description=(
            "Project a building against a decarbonisation pathway and return the "
            "first year its carbon intensity exceeds the pathway limit, with the "
            "year-by-year projection and cumulative excess emissions."
        ),
    )
    @_report_expected_failures
    def crrem_misalignment_year(
        baseline_intensity_kgco2e_per_m2: Annotated[
            float, Field(ge=0, description="Current whole-building carbon intensity")
        ],
        baseline_year: Annotated[int, Field(description="Year the baseline intensity relates to")],
        pathway: Annotated[
            str, Field(description="Name of the pathway dataset to project against")
        ] = "example-office-eu",
        annual_improvement_rate: Annotated[
            float,
            Field(
                ge=0,
                lt=1,
                description="Compound annual reduction in the asset's own intensity (0.02 = 2%/yr)",
            ),
        ] = 0.0,
        floor_area_m2: Annotated[
            float | None,
            Field(default=None, gt=0, description="Supply to also get excess emissions in tCO2e"),
        ] = None,
    ) -> dict[str, Any]:
        dataset = get_dataset(config.data_dir, "pathways", pathway)
        result = crrem.misalignment_year(
            baseline_intensity_kgco2e_per_m2=baseline_intensity_kgco2e_per_m2,
            baseline_year=baseline_year,
            pathway_kgco2e_per_m2=dataset.values,
            annual_improvement_rate=annual_improvement_rate,
            floor_area_m2=floor_area_m2,
        )
        result["provenance"] = dataset.citation()
        return result

    @server.tool(
        title="List reference datasets",
        description="List the emission factor sets and decarbonisation pathways this server can apply.",
    )
    @_report_expected_failures
    def list_reference_datasets() -> dict[str, Any]:
        out: dict[str, Any] = {"data_dir": str(config.data_dir)}
        for kind in ("factors", "pathways"):
            entries = []
            for name in list_datasets(config.data_dir, kind):
                try:
                    entries.append(get_dataset(config.data_dir, kind, name).citation())
                except DatasetError as exc:  # a malformed file should not hide the rest
                    entries.append({"dataset": f"{kind}/{name}", "error": str(exc)})
            out[kind] = entries
        return out

    @server.custom_route("/healthz", methods=["GET"], include_in_schema=False)
    async def healthz(_request: Request) -> JSONResponse:
        return JSONResponse({"status": "ok", "server": "nzcai", "version": "0.1.0"})

    return server


def run(config: Config | None = None) -> None:
    config = config or load_config()

    if config.transport == "stdio":
        # stdout is the transport, so logs must go to stderr.
        logging.basicConfig(level=logging.INFO, stream=sys.stderr)
        build_server(config).run(transport="stdio")
        return

    logging.basicConfig(level=logging.INFO)
    security = _transport_security(config)
    build_server(config).run(
        transport="streamable-http",
        host=config.host,
        port=config.port,
        transport_security=security,
    )


def _transport_security(config: Config) -> TransportSecuritySettings | None:
    """DNS-rebinding protection for the HTTP transport.

    Passing None disables it, which is only safe while the port is confined to the
    compose network. Set NZCAI_MCP_ALLOWED_HOSTS before exposing it any wider.
    """
    if not config.allowed_hosts and not config.allowed_origins:
        logger.warning(
            "NZCAI_MCP_ALLOWED_HOSTS is unset: DNS rebinding protection is OFF. "
            "Set it before exposing this port outside the container network."
        )
        return None
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=list(config.allowed_hosts),
        allowed_origins=list(config.allowed_origins),
    )
