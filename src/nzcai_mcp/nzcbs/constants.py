"""Fixed rules of UK NZCBS V1 Rev 1 written into the Standard's text rather than
its limit tables, each with the section it comes from. Figures that live in
Annex A (limits, targets, the GWP limit, the PV limit) are NOT here: they are
read from the versioned reference files.
"""

from __future__ import annotations

STANDARD_VERSION_LABEL = "Version 1, Rev 1 (April 2026)"

SECTORS = (
    "Commercial Residential",
    "Culture and Entertainment",
    "Data Centres",
    "Healthcare",
    "Higher Education",
    "Homes",
    "Hotels",
    "Offices",
    "Retail",
    "Schools",
    "Science and Technology",
    "Sport and Leisure",
    "Storage and Distribution",
)

REGIONS = (
    "A. Scotland",
    "B. Middle and North England, Northern Ireland, Wales",
    "C. South England",
)

# 4.1.2: publication of Version 1. Works that commenced before it are assessed
# but not compared with limits (5.1.6); refrigerant systems installed before it
# may use the 5.9.6 exception. The month is published; confirm the day.
VERSION_1_PUBLICATION_DATE = "2026-03-01"

UNCLASSIFIABLE_NIA_SHARE_LIMIT = 0.3  # 4.2.2 step 1
MINOR_SECTOR_NIA_SHARE = 0.1  # 4.2.2 step 3, 4.2.5.2
ADDITIONAL_USE_NIA_SHARE_LIMIT = 0.3  # 5.2.1.3
EQUATION_1B_MIN_NEW_SHARE = 0.1  # 4.2.5.2
EQUATION_1B_MAX_NEW_SHARE = 0.5
ERP_YEARS = 5  # 4.2.4.2
REPORTABLE_CAT_B_SHARE = 0.8  # 5.1.6.2
REUSED_SYSTEM_TARGET_REDUCTION = 0.15  # 5.3.5.1
RENEWABLES_MIN_CAPACITY_KWP_SINGLE_FAMILY = 1
RENEWABLES_MIN_CAPACITY_KWP_OTHER = 4
DEMAND_MANAGEMENT_MIN_GIA_M2 = 500  # 5.6.1.2
DEMAND_MANAGEMENT_MAX_RESOLUTION_MINUTES = 30  # 5.6.2
DHCN_FOSSIL_FREE_YEAR = 2040  # 5.7.6.2
SPACE_HEATING_EXISTING_FROM_YEAR = 2040  # 5.8.1.1
REFRIGERANT_EXCEPTION_RPEP_BEFORE = "2030-01-01"  # 5.9.6
OFFSET_VINTAGE_WINDOW_YEARS = 5  # 5.10.2.1

# Annex A3: the counties that make up "C. South England".
SOUTH_ENGLAND_COUNTIES = (
    "Bedfordshire", "Berkshire", "Bristol", "Buckinghamshire", "Cambridgeshire", "City of London",
    "Cornwall", "Devon", "Dorset", "East Sussex", "Essex", "Gloucestershire", "Greater London",
    "Hampshire", "Hertfordshire", "Isle of Wight", "Kent", "Norfolk", "Oxfordshire", "Somerset",
    "Suffolk", "Surrey", "West Sussex", "Wiltshire",
)

# Table 12: particular uses and the sector/subsector whose limit they take.
PARTICULAR_USE_LIMIT_SECTOR: dict[str, dict[str, str]] = {
    "entertainment": {"sector": "Culture and Entertainment"},
    "large_server_room": {"sector": "Data Centres"},
    "office_admin": {"sector": "Offices", "subsector": "General"},
    "catered_event_space": {"sector": "Retail", "subsector": "Food & beverage - with commercial kitchen"},
    "catering_kitchen": {"sector": "Retail", "subsector": "Food & beverage - with commercial kitchen"},
    "canteen_restaurant": {"sector": "Retail", "subsector": "Food & beverage - with commercial kitchen"},
    "cafe_no_catering": {"sector": "Retail", "subsector": "Food & beverage - no commercial kitchen"},
    "shop": {"sector": "Retail", "subsector": "High St. Retail"},
    "laboratory": {"sector": "Science and Technology", "subsector": "Laboratory buildings"},
    "gym": {"sector": "Sport and Leisure", "subsector": "Fitness"},
    "indoor_sports_dry": {"sector": "Sport and Leisure", "subsector": "Dry"},
    "pool_wet": {"sector": "Sport and Leisure", "subsector": "Wet"},
}

# Table 9: the Additional Uses each sector may claim.
ADDITIONAL_USES_BY_SECTOR: dict[str, tuple[str, ...]] = {
    "Commercial Residential": ("Laundry",),
    "Culture and Entertainment": ("Theatre production workshops",),
    "Hotels": ("Laundry",),
    "Retail": ("Waste storage and management areas",),
    "Schools": ("Community uses and other out-of-hours use", "Large specialist uses"),
    "Science and Technology": ("Safety critical equipment", "Higher performance laboratory spaces", "Close control spaces", "High process loads"),
    "Sport and Leisure": ("Community uses",),
}

# 5.5.5 allowable cases for fossil fuel use, as the proforma menu names them.
FOSSIL_FUEL_EXCEPTIONS = (
    "excluded_from_operational_scope",
    "emergency_and_life_safety",
    "class_iv_backup",
    "data_centre_backup_no_alternative",
    "scientific_process_no_alternative",
    "construction_process",
)
FOSSIL_FUELS = ("natural_gas", "oil", "lpg", "coal", "other_fossil", "biofuel_first_generation")

STATUS_LABELS = {
    "pass": "within limit",
    "fail": "above limit",
    "reported": "reported",
    "not_assessable": "not assessable",
    "not_applicable": "not applicable",
}

# 7.4.2: every communication of a verification must carry these.
VERIFIED_COMMUNICATION_MUST_INCLUDE = (
    "Standard version (4.1.2)",
    "Type of building and works (4.2.1)",
    "Sectors and subsectors within the building (4.2.1.1)",
    "Date of the Reporting Period End Point (4.2.4.1)",
    "Start and end dates of the Operational Reporting Period (4.2.4.2)",
    "Date of the limits and targets used (4.2.5.3)",
)
