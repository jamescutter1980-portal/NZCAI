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
from typing import Annotated, Any, Literal, TypeVar

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import Field
from starlette.requests import Request
from starlette.responses import JSONResponse

from .auth import BearerTokenMiddleware, validate_auth_config
from .config import Config, load_config
from .pathways import (
    ATTRIBUTION,
    LICENCE_NOTE,
    PathwayDataError,
    available_versions,
    load_version,
    require_series,
)
from .reference import (
    ReferenceDataError,
    available_years,
    load_year,
    resolve_fuel_factors,
)
from .tools import carbon, crrem, nzcbs
from .tools.carbon import CalculationError
from .nzcbs import (
    ATTRIBUTION as NZCBS_ATTRIBUTION,
    NzcbsDataError,
    bundled_reference_dir as nzcbs_bundled_dir,
    deployment_reference_dir as nzcbs_dir,
    find_limit as nzcbs_find_limit,
    list_versions as nzcbs_list_versions,
    load_reference as load_nzcbs,
)

logger = logging.getLogger(__name__)

F = TypeVar("F", bound=Callable[..., Any])

# Failures the caller can act on: a missing dataset, an out-of-range input. The SDK
# withholds the text of any other exception from the client and reports a bare
# "Error executing tool", so these are re-raised as ToolError to keep the detail --
# the model needs to read "available: example-uk" to correct its own argument.
EXPECTED_FAILURES = (CalculationError, ReferenceDataError, PathwayDataError, NzcbsDataError)


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

CRREM pathways are licensed data supplied per deployment. The UK NZCBS Version 1,
Rev 1 limit tables are bundled and checksummed. Both carry their publishers'
attribution.

A UK NZCBS check is a pre-verification comparison, not a verified claim: where the
Standard sets no limit, no value was supplied, or the selection is ambiguous, the
metric is reported `not_assessable` -- never a pass, and never a limit of zero.
Before verification a building may only be described as "targeting verification to
the UK Net Zero Carbon Buildings Standard".
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
            "Compare a building's carbon or energy intensity against a CRREM "
            "decarbonisation pathway and report the first year it exceeds the "
            "pathway. Supply a projected asset series for a CRREM-consistent "
            "result; a single value is held constant, which is a static projection."
        ),
    )
    @_report_expected_failures
    def crrem_misalignment_year(
        country_code: Annotated[str, Field(description="ISO alpha-2, e.g. GB")],
        property_type: Annotated[
            str, Field(description="CRREM property type as named in the file, e.g. Office")
        ],
        asset_series: Annotated[
            dict[str, float],
            Field(
                description=(
                    "Asset intensity by year in the pathway's unit, e.g. "
                    "{'2025': 65, '2026': 63}. A single entry is held constant "
                    "across every pathway year."
                )
            ),
        ],
        pathway_type: Annotated[
            Literal["ghg", "energy"], Field(description="GHG or energy intensity pathway")
        ] = "ghg",
        scenario: Annotated[Literal["1.5C", "2C"], Field(description="Warming scenario")] = "1.5C",
        version: Annotated[
            str | None,
            Field(default=None, description="CRREM release, e.g. v2.04. Defaults to the newest loaded."),
        ] = None,
        floor_area_m2: Annotated[
            float | None,
            Field(default=None, gt=0, description="Supply to also get excess emissions in tCO2e"),
        ] = None,
    ) -> dict[str, Any]:
        index = load_version(config.reference_dir, version)
        series = require_series(index, country_code, property_type, pathway_type, scenario)
        try:
            asset = [(int(year), value) for year, value in asset_series.items()]
        except (TypeError, ValueError) as exc:
            raise CalculationError(
                f"asset_series keys must be years: {sorted(asset_series)}"
            ) from exc

        result = crrem.misalignment_year(
            pathway=[(p.year, p.value) for p in series],
            asset_series=asset,
            floor_area_m2=floor_area_m2,
        )
        result["unit"] = series[0].unit
        result["provenance"] = {
            "source": "CRREM (Carbon Risk Real Estate Monitor)",
            "version": index.version,
            "file": index.file_name,
            "basis": "modelled",
            "selection": {
                "country_code": country_code.strip().upper(),
                "property_type": series[0].property_type,
                "pathway_type": pathway_type,
                "scenario": scenario,
            },
            "attribution": ATTRIBUTION,
            "licence": LICENCE_NOTE,
        }
        return result

    @server.tool(
        title="UK NZCBS limits",
        description=(
            "The UK Net Zero Carbon Buildings Standard (V1 Rev 1) limit for one Annex A "
            "table, sector, subsector, scope, area basis and Date of Commencement year, "
            "from the bundled Rev 1 tables. Tables: OE-1 (energy, New Buildings), OE-2 "
            "(energy, Existing, one-go route), OE-3 (energy, Existing, stepped route), "
            "OE-4 (space heating, New Buildings), EC-1/EC-2/EC-3 (upfront carbon for "
            "New, Retrofit and Reportable Works). A reference table, not a compliance "
            "determination; 'no limit' is a status, never zero."
        ),
    )
    @_report_expected_failures
    def nzcbs_limits(
        table: Annotated[Literal["OE-1", "OE-2", "OE-3", "OE-4", "EC-1", "EC-2", "EC-3"], Field(description="Annex A table")],
        sector: Annotated[str, Field(description="Table 6 sector, e.g. Offices, Retail, Homes")],
        year: Annotated[int, Field(description="Date of Commencement year (or ORP start year for the stepped route); clamped to 2025 to 2050")],
        subsector: Annotated[str | None, Field(default=None, description="E.g. General, Supermarket, Flats, Unconditioned Storage")] = None,
        scope: Annotated[str | None, Field(default=None, description="Offices and Storage: Whole building, Shell & Core + Cat A, Shell & Core only, Landlord-only, Tenant-only, Cat A + Cat B, Cat B")] = None,
        area_basis: Annotated[Literal["GIA", "NIA"] | None, Field(default=None, description="Offices may meet either (Table 10)")] = None,
        version: Annotated[str | None, Field(default=None, description="Reference version, e.g. v1r1. Defaults to the newest loaded.")] = None,
    ) -> dict[str, Any]:
        index = load_nzcbs(config.reference_dir, version)
        if index is None:
            loaded = [v.version for v in nzcbs_list_versions(config.reference_dir)]
            return {
                "rows": [],
                "detail": (
                    f"UK NZCBS version {version} is not loaded (loaded: {', '.join(loaded) or 'none'})."
                    if version
                    else f"No UK NZCBS reference tables found in {nzcbs_bundled_dir()} or {nzcbs_dir(config.reference_dir)}."
                ),
            }
        res = nzcbs_find_limit(index, table=table, sector=sector, year=year, subsector=subsector, scope=scope, area_basis=area_basis)
        warnings = list(res.notes) + [
            "Limits are the publisher's figures converted from the submission proforma; verify "
            "against the current publication before use in a submission."
        ]
        if res.status != "limit":
            warnings.insert(0, f"Status {res.status}: no numeric limit is returned, and none should be assumed.")
        return {
            "version": index.version,
            "file": index.file_name,
            "sectors_loaded": index.sectors,
            **res.as_dict(),
            "rows": [r.as_dict() for r in ([res.row] if res.row else res.candidates)],
            "attribution": NZCBS_ATTRIBUTION,
            "warnings": warnings,
        }

    @server.tool(
        title="UK NZCBS pre-verification check",
        description=(
            "Compare a building's values with the UK NZCBS V1 Rev 1 limits the Standard "
            "selects for its sector, building type, route and year. Metrics: eui "
            "(kWh/m2/yr), pue, upfront_carbon (kgCO2e/m2GIA, with works_type), "
            "space_heating (kWh/m2GIA/yr, New Buildings), renewables_per_footprint "
            "(kWh/m2 footprint/yr, with region), refrigerant_gwp (kgCO2e/kg), "
            "pv_upfront_carbon_per_kwp. Anything without a limit or a value is "
            "not_assessable, never a pass. Not a verified NZCBS assessment: before "
            "verification a building is only 'targeting verification'."
        ),
    )
    @_report_expected_failures
    def nzcbs_check(
        sector: Annotated[str, Field(description="Table 6 sector")],
        year: Annotated[int, Field(description="Date of Commencement year per 5.2.7.1 (New Works commencement for New Buildings; latest Retrofit Works commencement or 2025 for the one-go route; ORP start year for the stepped route)")],
        asset_values: Annotated[dict[str, float] | None, Field(default=None, description="Your building's value per metric, e.g. {'eui': 95}. Omit a metric and it is reported not_assessable.")] = None,
        building_type: Annotated[Literal["New Building", "Existing Building"], Field(default="Existing Building", description="Table 4")] = "Existing Building",
        route: Annotated[Literal["one-go", "stepped"], Field(default="one-go", description="5.2.7.1 route for Existing Buildings")] = "one-go",
        subsector: Annotated[str | None, Field(default=None)] = None,
        scope: Annotated[str | None, Field(default=None, description="Offices and Storage scope column")] = None,
        area_basis: Annotated[Literal["GIA", "NIA"] | None, Field(default=None, description="Offices: GIA (default) or NIA")] = None,
        works_type: Annotated[Literal["New Works", "Retrofit Works", "Reportable Works"] | None, Field(default=None, description="Needed for upfront_carbon")] = None,
        region: Annotated[str | None, Field(default=None, description="Annex A3 region: 'A. Scotland', 'B. Middle and North England, Northern Ireland, Wales', 'C. South England'")] = None,
        single_family_home_or_single_storey_storage: Annotated[bool, Field(default=False, description="Annex A3 higher target group")] = False,
        version: Annotated[str | None, Field(default=None, description="Reference version. Defaults to the newest loaded.")] = None,
    ) -> dict[str, Any]:
        index = load_nzcbs(config.reference_dir, version)
        return nzcbs.check(
            index,
            sector=sector, year=year, asset_values=asset_values or {},
            building_type=building_type, route=route, subsector=subsector, scope=scope, area_basis=area_basis,
            works_type=works_type, region=region,
            single_family_home_or_single_storey_storage=single_family_home_or_single_storey_storage,
            loaded_versions=[v.version for v in nzcbs_list_versions(config.reference_dir)],
            requested_version=version,
            deployment_dir=str(nzcbs_dir(config.reference_dir)),
            bundled_dir=str(nzcbs_bundled_dir()),
        )

    @server.tool(
        title="List reference datasets",
        description=(
            "Report which DESNZ conversion factor years, CRREM pathway versions and "
            "UK NZCBS reference versions are loaded, and what each covers."
        ),
    )
    @_report_expected_failures
    def list_reference_datasets() -> dict[str, Any]:
        years = available_years(config.reference_dir)
        versions = available_versions(config.reference_dir)
        pathways: dict[str, Any] = {
            "versions_loaded": versions,
            "detail": (
                None
                if versions
                else (
                    "No CRREM pathway file loaded. Export the pathway tables to "
                    f"{config.reference_dir}/crrem-pathways/<version>.csv "
                    "(docs/integrations/reference-data.md)."
                )
            ),
        }
        if versions:
            newest = load_version(config.reference_dir, versions[0])
            pathways["newest"] = {
                "version": newest.version,
                "file": newest.file_name,
                "countries": newest.countries,
                "property_types": newest.property_types,
                "points": len(newest.points),
            }
            pathways["attribution"] = ATTRIBUTION
        return {
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
            "crrem_pathways": pathways,
            "uk_nzcbs": _nzcbs_summary(config),
        }

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


def _nzcbs_summary(config: Config) -> dict[str, Any]:
    versions = nzcbs_list_versions(config.reference_dir)
    if not versions:
        return {
            "versions_loaded": [],
            "detail": (
                f"No UK NZCBS reference tables found in {nzcbs_bundled_dir()} or "
                f"{nzcbs_dir(config.reference_dir)} (docs/integrations/reference-data.md)."
            ),
        }
    newest = load_nzcbs(config.reference_dir, versions[0].version)
    return {
        "versions_loaded": [v.version for v in versions],
        "newest": {
            "version": newest.version, "file": newest.file_name, "source": "bundled" if newest.bundled else "deployment",
            "standard": newest.manifest.get("standard"), "proforma": newest.manifest.get("proforma"),
            "sectors": newest.sectors, "tables": sorted({r.table for r in newest.limits}), "rows": len(newest.limits),
        },
        "attribution": NZCBS_ATTRIBUTION,
    }


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
