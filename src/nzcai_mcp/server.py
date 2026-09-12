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

from .auth import BearerTokenMiddleware, validate_auth_config
from .config import Config, load_config
from .datasets import DatasetError, get_dataset, list_datasets
from .reference import (
    ReferenceDataError,
    available_years,
    load_year,
    resolve_fuel_factors,
)
from .tools import carbon, crrem
from .tools.carbon import CalculationError

logger = logging.getLogger(__name__)

F = TypeVar("F", bound=Callable[..., Any])

# Failures the caller can act on: a missing dataset, an out-of-range input. The SDK
# withholds the text of any other exception from the client and reports a bare
# "Error executing tool", so these are re-raised as ToolError to keep the detail --
# the model needs to read "available: example-uk" to correct its own argument.
EXPECTED_FAILURES = (DatasetError, CalculationError, ReferenceDataError)


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

Emission factors are resolved from the published DESNZ flat file for the reporting
year -- never from a value held in this server. Every result carries a `provenance`
block naming the publication, the row ids used and the file, so any number can be
traced back to its published row.

A factor published as blank means "not available" and is refused rather than
treated as zero.
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
            "intensities (EUI and kgCO2e/m2) using the published DESNZ conversion "
            "factors for the reporting year. Location-based Scope 2 combines the UK "
            "electricity generation and transmission & distribution rows; supply a "
            "supplier factor for the market-based figure as well."
        ),
    )
    @_report_expected_failures
    def calculate_carbon_intensity(
        consumption_kwh: Annotated[
            dict[str, float],
            Field(description="Annual kWh by fuel, e.g. {'electricity': 250000, 'natural_gas': 480000}"),
        ],
        floor_area_m2: Annotated[float, Field(gt=0, description="Gross internal area in m2")],
        reporting_year: Annotated[
            int,
            Field(description="Reporting year, selecting which DESNZ flat file to apply"),
        ],
        factor_row_ids: Annotated[
            dict[str, str] | None,
            Field(
                default=None,
                description=(
                    "DESNZ row id per fuel, for anything beyond 'electricity' and "
                    "'natural_gas'. Find ids with search_emission_factors."
                ),
            ),
        ] = None,
        market_based_electricity_factor: Annotated[
            float | None,
            Field(
                default=None,
                ge=0,
                description="Supplier-specific electricity factor in kgCO2e/kWh for market-based Scope 2",
            ),
        ] = None,
    ) -> dict[str, Any]:
        index = load_year(config.reference_dir, reporting_year)
        resolved = resolve_fuel_factors(index, consumption_kwh.keys(), factor_row_ids)
        result = carbon.calculate_carbon_intensity(
            consumption_kwh=consumption_kwh,
            floor_area_m2=floor_area_m2,
            factors_kgco2e_per_kwh={f: r.value for f, r in resolved.items()},
            market_based_electricity_factor=market_based_electricity_factor,
        )
        result["provenance"] = {
            "source": "DESNZ UK Government GHG Conversion Factors for Company Reporting",
            "reporting_year": reporting_year,
            "file": index.file_name,
            "factors": {f: r.provenance(index) for f, r in resolved.items()},
        }
        return result

    @server.tool(
        title="Search emission factors",
        description=(
            "Search the loaded DESNZ flat file for a reporting year and return "
            "matching rows with their ids, so a fuel or activity can point at a "
            "published row. Only rows actually loaded are offered."
        ),
    )
    @_report_expected_failures
    def search_emission_factors(
        reporting_year: Annotated[int, Field(description="Reporting year to search")],
        query: Annotated[
            str | None,
            Field(default=None, description="Free text matched across the level and unit columns"),
        ] = None,
        level1: Annotated[
            str | None, Field(default=None, description="Restrict to one Level 1 category")
        ] = None,
        limit: Annotated[int, Field(default=50, ge=1, le=500)] = 50,
    ) -> dict[str, Any]:
        index = load_year(config.reference_dir, reporting_year)
        needle = (query or "").strip().lower()
        rows = [
            r for r in index.rows
            if (not level1 or r.level1.lower() == level1.lower())
            and (
                not needle
                or needle in f"{r.level1} {r.level2} {r.level3} {r.level4} "
                             f"{r.column_text} {r.uom}".lower()
            )
        ]
        return {
            "reporting_year": reporting_year,
            "file": index.file_name,
            "total_matching": len(rows),
            "levels": sorted({r.level1 for r in index.rows if r.level1}),
            "rows": [
                {
                    "id": r.id, "scope": r.scope, "description": r.describe(),
                    "column_text": r.column_text, "uom": r.uom, "ghg_unit": r.ghg_unit,
                    "factor": r.factor, "availability": r.availability,
                }
                for r in rows[:limit]
            ],
        }

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
        description=(
            "Report which DESNZ conversion factor years are loaded and which "
            "decarbonisation pathways are available."
        ),
    )
    @_report_expected_failures
    def list_reference_datasets() -> dict[str, Any]:
        years = available_years(config.reference_dir)
        out: dict[str, Any] = {
            "reference_dir": str(config.reference_dir),
            "desnz_conversion_factors": {
                "years_loaded": years,
                "detail": (
                    None
                    if years
                    else (
                        "No DESNZ flat file loaded. Export the 'Factors by Category' "
                        f"sheet to CSV and save it as {config.reference_dir}/"
                        "desnz-conversion-factors/<year>.csv "
                        "(docs/integrations/reference-data.md)."
                    )
                ),
            },
        }
        pathways = []
        for name in list_datasets(config.data_dir, "pathways"):
            try:
                pathways.append(get_dataset(config.data_dir, "pathways", name).citation())
            except DatasetError as exc:
                pathways.append({"dataset": f"pathways/{name}", "error": str(exc)})
        out["pathways"] = pathways
        return out

    @server.custom_route("/healthz", methods=["GET"], include_in_schema=False)
    async def healthz(_request: Request) -> JSONResponse:
        return JSONResponse({"status": "ok", "server": "nzcai", "version": "0.1.0"})

    return server


def build_http_app(config: Config):
    """The ASGI app for the HTTP transport, with auth wrapped around it.

    Separated from ``run`` so tests can drive the fully wired app -- auth included
    -- without binding a port.
    """
    app = build_server(config).streamable_http_app(
        transport_security=_transport_security(config),
        host=config.host,
    )
    if config.auth_token is None:
        return app
    return BearerTokenMiddleware(app, config.auth_token)


def run(config: Config | None = None) -> None:
    config = config or load_config()

    # Checked before anything binds, so a misconfiguration fails at startup rather
    # than quietly serving an open endpoint.
    validate_auth_config(config.transport, config.auth_token, config.allow_anonymous)

    if config.transport == "stdio":
        # stdout is the transport, so logs must go to stderr.
        logging.basicConfig(level=logging.INFO, stream=sys.stderr)
        build_server(config).run(transport="stdio")
        return

    import uvicorn

    logging.basicConfig(level=logging.INFO)
    uvicorn.run(build_http_app(config), host=config.host, port=config.port, log_level="info")


def _transport_security(config: Config) -> TransportSecuritySettings | None:
    """DNS-rebinding protection for the HTTP transport.

    Returning None hands the decision to the SDK, which auto-protects only a
    loopback bind (127.0.0.1, localhost, ::1) and leaves any other bind address
    unguarded. The container binds 0.0.0.0, so an explicit allowlist is the only
    thing standing between it and a rebinding attack -- hence the warning.
    """
    if not config.allowed_hosts and not config.allowed_origins:
        if config.host in ("127.0.0.1", "localhost", "::1"):
            logger.info(
                "NZCAI_MCP_ALLOWED_HOSTS is unset; the SDK's loopback default applies."
            )
        else:
            logger.warning(
                "NZCAI_MCP_ALLOWED_HOSTS is unset and the bind address is %s, so DNS "
                "rebinding protection is OFF. Set it before exposing this port.",
                config.host,
            )
        return None
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=list(config.allowed_hosts),
        allowed_origins=list(config.allowed_origins),
    )
