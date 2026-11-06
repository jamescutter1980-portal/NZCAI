/**
 * Fixed rules of UK NZCBS V1 Rev 1 that are written into the Standard's text
 * rather than its limit tables. Each carries the section it comes from. Values
 * that live in Annex A (limits, targets, the GWP limit, the PV limit) are NOT
 * here: they are loaded from the versioned reference files.
 */

export const STANDARD_NAME = "UK Net Zero Carbon Buildings Standard";
export const STANDARD_VERSION_LABEL = "Version 1, Rev 1 (April 2026)";

/**
 * Publication of Version 1 of the Standard (4.1.2). Works that commenced
 * before this date are assessed and reported but not compared with limits
 * (5.1.6). Refrigerant systems installed before it may use the 5.9.6 exception.
 * The month is published; the day is taken as the first of the month and
 * should be confirmed against the Standard's front matter.
 */
export const VERSION_1_PUBLICATION_DATE = "2026-03-01";

/** 4.2.2 step 1: a building with this share or more of unclassifiable NIA cannot claim. */
export const UNCLASSIFIABLE_NIA_SHARE_LIMIT = 0.3;
/** 4.2.2 step 3 and 4.2.5.2: sectors under this NIA share may be omitted. */
export const MINOR_SECTOR_NIA_SHARE = 0.1;
/** 5.2.1.3: Additional Uses may cover at most this share of NIA. */
export const ADDITIONAL_USE_NIA_SHARE_LIMIT = 0.3;

/** Table 4 and Table 5: new NIA share that makes a New Building or New Works. */
export const NEW_BUILDING_NIA_SHARE = 0.5;
/** Table 5: thermal envelope or glazed area share that makes Retrofit Works. */
export const RETROFIT_ENVELOPE_SHARE = 0.1;
/** Table 5: works value that makes Reportable Works. */
export const REPORTABLE_WORKS_VALUE_GBP = 100_000;
/** 4.2.5.2: Equation 1b applies when the New Area share of NIA is in this range. */
export const EQUATION_1B_MIN_NEW_SHARE = 0.1;
export const EQUATION_1B_MAX_NEW_SHARE = 0.5;

/** 4.2.4.2: the ERP starts five years before the RPEP unless verified more recently. */
export const ERP_YEARS = 5;
/** 4.2.4.2: the ORP is the twelve months before the RPEP. */
export const ORP_MONTHS = 12;

/** 5.2.5.1. */
export const MINIMUM_OCCUPANCY_RATE = 0.8;

/** Annex A tables run from 2025 to 2050; 5.2.7.1 uses 2025 for earlier dates. */
export const LIMIT_TABLE_FIRST_YEAR = 2025;
export const LIMIT_TABLE_LAST_YEAR = 2050;

/** 5.1.6.2: Cat B limits apply when Cat B is more than this share of upfront carbon. */
export const REPORTABLE_CAT_B_SHARE = 0.8;

/** 5.3.5.1. */
export const REUSED_SYSTEM_TARGET_REDUCTION = 0.15;
export const RENEWABLES_MIN_CAPACITY_KWP_SINGLE_FAMILY = 1;
export const RENEWABLES_MIN_CAPACITY_KWP_OTHER = 4;

/** 5.6.1.2. */
export const DEMAND_MANAGEMENT_MIN_GIA_M2 = 500;
/** 5.6.2: half-hourly or finer. */
export const DEMAND_MANAGEMENT_MAX_RESOLUTION_MINUTES = 30;

/** 5.7.6.2 and 5.7.6.3 default plant assumptions. */
export const DHCN_ASHP_SCOP = 2.8;
export const DHCN_PRIMARY_DISTRIBUTION_LOSSES = 0.2;
export const DHCN_PARASITIC_ENERGY = 0.02;
export const DHCN_CHILLER_SEER = 3;
/** 5.7.6.2: existing networks must stop supplying fossil heat from this date. */
export const DHCN_FOSSIL_FREE_YEAR = 2040;

/** 5.8.1.1: Existing Buildings report delivered heating and cooling from this RPEP year. */
export const SPACE_HEATING_EXISTING_FROM_YEAR = 2040;

/** 5.9.1.2: leakage is assessed where the building's charge in CO2e reaches this. */
export const REFRIGERANT_CHARGE_REPORTING_THRESHOLD_KGCO2E = 3000;
/** 5.9.6: the pre-Version-1 exception holds only while the RPEP is before this date. */
export const REFRIGERANT_EXCEPTION_RPEP_BEFORE = "2030-01-01";

/** 5.10.2.1: credit vintage within this many years of the RPEP. */
export const OFFSET_VINTAGE_WINDOW_YEARS = 5;

/** Annex A3: the counties that make up "C. South England". */
export const SOUTH_ENGLAND_COUNTIES = [
  "Bedfordshire",
  "Berkshire",
  "Bristol",
  "Buckinghamshire",
  "Cambridgeshire",
  "City of London",
  "Cornwall",
  "Devon",
  "Dorset",
  "East Sussex",
  "Essex",
  "Gloucestershire",
  "Greater London",
  "Hampshire",
  "Hertfordshire",
  "Isle of Wight",
  "Kent",
  "Norfolk",
  "Oxfordshire",
  "Somerset",
  "Suffolk",
  "Surrey",
  "West Sussex",
  "Wiltshire",
] as const;

/** Table 12: particular uses and the sector/subsector whose limit they take. */
export const PARTICULAR_USE_LIMIT_SECTOR: Record<string, { sector: string; subsector?: string }> = {
  entertainment: { sector: "Culture and Entertainment" },
  large_server_room: { sector: "Data Centres" },
  office_admin: { sector: "Offices", subsector: "General" },
  catered_event_space: { sector: "Retail", subsector: "Food & beverage - with commercial kitchen" },
  catering_kitchen: { sector: "Retail", subsector: "Food & beverage - with commercial kitchen" },
  canteen_restaurant: { sector: "Retail", subsector: "Food & beverage - with commercial kitchen" },
  cafe_no_catering: { sector: "Retail", subsector: "Food & beverage - no commercial kitchen" },
  shop: { sector: "Retail", subsector: "High St. Retail" },
  laboratory: { sector: "Science and Technology", subsector: "Laboratory buildings" },
  gym: { sector: "Sport and Leisure", subsector: "Fitness" },
  indoor_sports_dry: { sector: "Sport and Leisure", subsector: "Dry" },
  pool_wet: { sector: "Sport and Leisure", subsector: "Wet" },
};

/** Table 9: the Additional Uses each sector may claim. */
export const ADDITIONAL_USES_BY_SECTOR: Record<string, string[]> = {
  "Commercial Residential": ["Laundry"],
  "Culture and Entertainment": ["Theatre production workshops"],
  Hotels: ["Laundry"],
  Retail: ["Waste storage and management areas"],
  Schools: ["Community uses and other out-of-hours use", "Large specialist uses"],
  "Science and Technology": ["Safety critical equipment", "Higher performance laboratory spaces", "Close control spaces", "High process loads"],
  "Sport and Leisure": ["Community uses"],
};

/** Section 7.4: the only phrase permitted before verification. */
export const PRE_VERIFICATION_STATEMENT = `targeting verification to the ${STANDARD_NAME}`;
