"""UK Net Zero Carbon Buildings Standard, Version 1, Rev 1, for NZC AI.

- ``reference``: the bundled, checksummed limit tables and the Standard's equations.
- ``classify``: section 4 classification and reporting periods.
- ``limits``: limit selection (5.2.7.1, 5.1.6, Equations 1a, 1b and 5, Annex A3).
- ``aspects``: the section 5 aspects as pure functions.
- ``engine``: ``assess_building`` and ``classify_building_profile``.

The same test vectors as the portal's engine (tests/nzcbs/vectors.json) run here.
"""

from .classify import NzcbsInputError, classify_building, classify_sectors, region_for, reporting_periods, works_type as classify_works
from .constants import PARTICULAR_USE_LIMIT_SECTOR, REGIONS, SECTORS, STANDARD_VERSION_LABEL, STATUS_LABELS
from .engine import assess_building, classify_building_profile, validate_profile
from .limits import embodied_carbon_limit, operational_energy_limit, operational_limit_year, renewables_target_for, resolve_limits, space_heating_limit
from .reference import (
    ATTRIBUTION,
    DISCLAIMER,
    PRE_VERIFICATION_STATEMENT,
    STANDARD_NAME,
    LimitResolution,
    LimitRow,
    NzcbsDataError,
    OtherLimit,
    Reference,
    RenewablesTarget,
    Version,
    bundled_reference_dir,
    clamp_limit_year,
    clear_cache,
    contains_prohibited_claim,
    demand_statistics,
    deployment_reference_dir,
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
    operational_table,
    other_limit,
    percentile_inclusive,
    refrigerant_charge_kgco2e,
    renewables_target,
    works_type,
)

__all__ = [
    "ATTRIBUTION", "DISCLAIMER", "PRE_VERIFICATION_STATEMENT", "STANDARD_NAME", "STANDARD_VERSION_LABEL", "SECTORS", "REGIONS",
    "STATUS_LABELS", "PARTICULAR_USE_LIMIT_SECTOR",
    "LimitResolution", "LimitRow", "NzcbsDataError", "NzcbsInputError", "OtherLimit", "Reference", "RenewablesTarget", "Version",
    "bundled_reference_dir", "deployment_reference_dir", "list_versions", "load_reference", "clear_cache",
    "find_limit", "clamp_limit_year", "renewables_target", "other_limit", "operational_table",
    "grid_factor", "occupancy_rate", "equation_1a", "equation_1b", "equation_5", "network_limit", "network_energy_use",
    "network_carbon_factor", "refrigerant_charge_kgco2e", "leakage_kg", "percentile_inclusive", "demand_statistics",
    "works_type", "contains_prohibited_claim",
    "classify_building", "classify_sectors", "classify_works", "region_for", "reporting_periods",
    "operational_limit_year", "operational_energy_limit", "embodied_carbon_limit", "space_heating_limit", "renewables_target_for", "resolve_limits",
    "assess_building", "classify_building_profile", "validate_profile",
]
