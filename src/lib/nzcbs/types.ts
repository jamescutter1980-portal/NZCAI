/**
 * UK Net Zero Carbon Buildings Standard, Version 1, Rev 1 (April 2026).
 *
 * Input and result types for the rule engine. Every field maps to a term the
 * Standard defines; the section is given where the name alone is not enough.
 * Nothing here touches a database or the network: the portal (and the MCP
 * layer) build these inputs from their own records and call the pure
 * functions in this module.
 */

export const SECTORS = [
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
] as const;
export type Sector = (typeof SECTORS)[number];

/** Table 4. */
export type BuildingType = "New Building" | "Existing Building";
/** Table 5. */
export type WorksType = "New Works" | "Retrofit Works" | "Reportable Works" | "Non-Reportable Works";
/** 5.2.7.1: how an Existing Building chooses its operational energy limits. */
export type OperationalRoute = "one-go" | "stepped";
export type AreaBasis = "GIA" | "NIA";
/** Annex A3 regions, named as the proforma menu names them. */
export type Region = "A. Scotland" | "B. Middle and North England, Northern Ireland, Wales" | "C. South England";
/** 4.3. */
export type Approach = "whole-building" | "landlord-only" | "tenant-only";

/** Annex A limit tables. */
export type LimitTable = "EC-1" | "EC-2" | "EC-3" | "OE-1" | "OE-2" | "OE-3" | "OE-4";

/**
 * Table 12 uses that are classified to a particular sector or subsector when
 * setting the operational energy limit, without changing the building's own
 * classification.
 */
export type ParticularUse =
  | "entertainment"
  | "large_server_room"
  | "office_admin"
  | "catered_event_space"
  | "catering_kitchen"
  | "canteen_restaurant"
  | "cafe_no_catering"
  | "shop"
  | "laboratory"
  | "gym"
  | "indoor_sports_dry"
  | "pool_wet";

/** One area of floor and how it is classified (4.2.2, 5.2.1.3, Table 12). */
export interface FloorArea {
  /** Table 6 sector. Null means unclassifiable (4.2.2 step 1). */
  sector: Sector | null;
  /** Table 6 subsector, spelled as the limit tables spell it (e.g. "General", "Supermarket"). */
  subsector?: string;
  /** Scope column for Offices and Storage limits: "Whole building", "Shell & Core + Cat A", "Shell & Core only", "Landlord-only", "Tenant-only". */
  scope?: string;
  niaM2: number;
  /** GIA attributable to this area; used by Equation 1b and the occupancy test. */
  giaM2?: number;
  /** 3.1.4.10: structure completed within five years before the RPEP. */
  newArea?: boolean;
  /** Table 9 Additional Use label, when the area is claimed as one. */
  additionalUse?: string;
  /** Whether the Additional Use is submetered, which 5.2.1.3 requires. */
  submetered?: boolean;
  /** 5.2.7.1: out-of-hours community use keeps its area in the EUI denominator. */
  outOfHoursUse?: boolean;
  /** Table 12 particular use, which overrides the sector for limit-setting. */
  particularUse?: ParticularUse;
  /** Internal car park (5.2.1.2 and 5.2.7.1): omitted from the EUI denominator when its energy is submetered. */
  carPark?: boolean;
}

/** Facts that decide the works type under Table 5. */
export interface WorksFacts {
  /** Share (0 to 1) of the building's completed NIA that is new as a result of these works. */
  newNiaShare?: number;
  /** Building is single-storey and everything above the ground floor slab is new. */
  singleStoreyAllNewAboveSlab?: boolean;
  /** Share (0 to 1) of the original thermal envelope area that is new, upgraded or replaced. */
  thermalEnvelopeShareReplaced?: number;
  /** Share (0 to 1) of the original glazed area that is new, upgraded or replaced. */
  glazedAreaShareReplaced?: number;
  /** Total material, labour and design cost excluding VAT. */
  valueGbp?: number;
  newOrReplacedHvacPlant?: boolean;
  replacedLightingSystems?: boolean;
  /** First fit-out of a building belongs to the New or Retrofit Works (Table 5 note c). */
  firstFitOut?: boolean;
}

/** Imported results of a RICS PS whole life carbon assessment for one programme of works. */
export interface EmbodiedCarbonFigures {
  /** Upfront carbon (A1 to A5) within the 5.1.2.4 scope, in kgCO2e. */
  upfrontKgCo2e?: number;
  /** Split needed for Reportable Works (5.1.6.2). */
  upfrontCatBKgCo2e?: number;
  upfrontShellCoreAndCatAKgCo2e?: number;
  /** GIA over which the upfront carbon is normalised. */
  giaM2?: number;
  /** Reporting metrics (Table 8). */
  lifeCycleKgCo2ePerM2?: number;
  genericSpecificationKgCo2ePerM2?: number;
  /** New on-site PV installed by the works (5.1.6.4). */
  pvKwp?: number;
  pvUpfrontKgCo2e?: number;
  /** Works scope label for Offices and Storage limits. */
  scope?: string;
}

export interface WorksProgramme {
  id: string;
  /** Table 5 type. When absent the engine classifies from `facts`. */
  type?: WorksType;
  /** 4.2.6 Date of Commencement, ISO date. */
  commencementDate: string;
  /** Practical completion, ISO date. Decides whether the works fall in the ERP. */
  completionDate?: string;
  facts?: WorksFacts;
  embodied?: EmbodiedCarbonFigures;
}

export interface BuildingProfile {
  /** Reference version folder, e.g. "v1r1". Defaults to the newest loaded. */
  referenceVersion?: string;
  /** Reporting Period End Point, ISO date (4.2.4.1). */
  rpep: string;
  /** Previous RPEP where the building was verified before (4.2.4.2). */
  previousRpep?: string;
  giaM2: number;
  niaM2: number;
  /** 5.3.2 building footprint. */
  footprintM2?: number;
  /** Annex A3 gives single-storey Storage and Distribution the higher renewables target. */
  singleStorey?: boolean;
  region?: Region;
  approach?: Approach;
  areas: FloorArea[];
  works?: WorksProgramme[];
  /** Table 4: a building keeps "New Building" once a previous submission classified it so. */
  previouslyClassifiedNewBuilding?: boolean;
  /** 5.2.7.1 route for Existing Buildings. */
  operationalRoute?: OperationalRoute;
  /** Table 10: Offices may meet either the GIA or the NIA limit. */
  areaBasis?: AreaBasis;
  /** 5.2.5.1: false for data centres, cold stores, archives and similar. Defaults to true. */
  intendedToBeOccupied?: boolean;
  /** Whether sectors under 10% of NIA are omitted from classification and Equation 1a (4.2.2 step 3, optional). Defaults to true. */
  omitMinorSectors?: boolean;
}

/* ------------------------------------------------------------------ */
/* Operational inputs                                                  */
/* ------------------------------------------------------------------ */

export type SupplyKind =
  | "grid_electricity"
  | "natural_gas"
  | "bulk_fuel"
  | "biofuel"
  | "district_heat"
  | "district_cooling"
  | "chp_electricity"
  | "chp_heat"
  | "onsite_renewable_electricity_used"
  | "onsite_renewable_heat";

/** 5.2.1.2 exclusions and the 5.2.7.1 car park omission. */
export type EnergyExclusion = "industrial_process" | "external_works" | "car_park_submetered";

export interface EnergySupply {
  kind: SupplyKind;
  /** Fuel name for bulk fuels and biofuels, e.g. "Gas oil", "Wood pellets". */
  fuel?: string;
  kwh: number;
  /** Measurement method, for the submission statement (Table 11). */
  measurement?: "meter_readings" | "stock_and_deliveries" | "heat_meter" | "estimated";
  excluded?: EnergyExclusion;
  /** Energy of a submetered Additional Use (5.2.1.3). */
  additionalUse?: boolean;
  /** Energy of areas classified as Data Centres, measured separately (5.2.7.1). */
  dataCentre?: boolean;
  /**
   * Emission factor for this supply on the Standard's basis (5.2.3.2 to 5.2.3.7),
   * kgCO2e per kWh. For grid electricity leave it out and give `gridFactors`;
   * for fuels include the WTT component. Null means unavailable.
   */
  factorKgCo2ePerKwh?: number | null;
  factorReference?: string;
}

/** 5.2.3.4: the four DESNZ lines that together make the Standard's grid factor. */
export interface GridFactors {
  generation: number;
  transmissionAndDistribution: number;
  wttGeneration: number;
  wttTransmissionAndDistribution: number;
  reference?: string;
}

/** Equation 4 inputs, measured on the first day of the ORP (5.2.5). */
export interface OccupancyInput {
  totalGiaM2: number;
  /** Au: floor area not intended to be occupied. */
  unoccupiableGiaM2: number;
  /** St: sum of separately occupiable spaces that meet the four tests. */
  occupiedGiaM2: number;
  /** For buildings not intended to be occupied: operational on day one. */
  operationalOnFirstDay?: boolean;
}

export interface OperationalEnergyInput {
  supplies: EnergySupply[];
  gridFactors?: GridFactors;
  occupancy?: OccupancyInput;
  /** Data Centres: IT equipment energy for the PUE. */
  itEnergyKwh?: number;
  /** Hotels: conditioned area and bedrooms for the reporting metrics. */
  conditionedAreaM2?: number;
  bedrooms?: number;
  /** Retail landlord areas: common parts area. */
  commonPartsAreaM2?: number;
}

export interface RenewableSystem {
  technology: "photovoltaics" | "wind" | "hydroelectric";
  capacityKw: number;
  generatedKwh: number;
  exportedKwh: number;
  /** 5.3.5.1: already in use before the relevant works, or already on the Existing Building. */
  reused?: boolean;
  /** 5.3.1.2: connected to the consumer side of the primary meter. */
  consumerSideOfPrimaryMeter?: boolean;
}

export type RenewablesConstraint =
  | "planning_or_legal"
  | "available_space"
  | "overshadowed_roofs"
  | "grid_connectivity"
  | "access"
  | "structural_capacity"
  | "existing_plant_areas"
  | "existing_rooflights";

export interface RenewablesInput {
  systems: RenewableSystem[];
  /** Equation 5: AU, unconstrained area within the curtilage, with the claimed constraints. */
  constraints?: { unconstrainedAreaM2: number; reasons: RenewablesConstraint[]; evidence?: string };
  /** Feasible peak capacity after constraints, for the 1 kWp and 4 kWp floors. */
  feasibleCapacityKwp?: number;
  /** Apply the optional reduction to the in-scope electricity limit (5.3.5.1). */
  capAtElectricityLimit?: boolean;
}

export interface WaterSource {
  source: "network" | "groundwater" | "rainwater" | "greywater" | "treated_blackwater" | "other";
  m3: number;
  /** DESNZ "water supply" factor or an equivalent-scope source factor, kgCO2e per m3. */
  supplyFactorKgCo2ePerM3?: number | null;
  excludedProcess?: boolean;
}

export interface WaterInput {
  sources: WaterSource[];
  /** Metered disposal to the supplier's drains, when metered. */
  meteredDisposalM3?: number;
  /** Disposed on site (septic, soakaway): factor zero. */
  onsiteDisposalM3?: number;
  treatmentFactorKgCo2ePerM3?: number | null;
  residents?: number;
  pupils?: number;
  itEnergyKwh?: number;
}

export type FossilFuel = "natural_gas" | "oil" | "lpg" | "coal" | "other_fossil" | "biofuel_first_generation" | "biofuel_second_generation" | "biofuel_waste_derived";

/** 5.5.5 allowable cases, named as the proforma menu names them. */
export type FossilFuelException =
  | "excluded_from_operational_scope"
  | "emergency_and_life_safety"
  | "class_iv_backup"
  | "data_centre_backup_no_alternative"
  | "scientific_process_no_alternative"
  | "construction_process";

export interface FossilFuelSystem {
  description: string;
  fuel: FossilFuel;
  exception?: FossilFuelException;
  /** 5.5.5 biofuel conditions. */
  biofuel?: { feedstockOrigin: "UK" | "EEA" | "other"; certifiedLowIlucRisk: boolean; evidence?: string };
}

export interface FossilFuelInput {
  systems: FossilFuelSystem[];
  /** Fossil or biofuel supplies seen in the energy data, to catch an undeclared gas supply. */
  supplies?: EnergySupply[];
}

export interface DemandInput {
  giaM2: number;
  /** Minutes between readings. */
  resolutionMinutes: number;
  /** Energy per interval in kWh, in time order, over the ORP. */
  intervalKwh: number[];
  /** Readings for electricity use that is out of scope and should be excluded. */
  excludedIntervalKwh?: number[];
}

export interface DistrictNetwork {
  name: string;
  service: "heating" | "cooling";
  /** 5.7.6.2: in operation or under construction on or before Version 1. */
  existing: boolean;
  /** Heat meter at the connection, kWh over the ORP. */
  meteredKwh: number;
  /** Equation 2a and 2b inputs for the whole network. */
  systemDeliveredKwh: number;
  generationInputKwh: number;
  distributionInputKwh: number;
  generationKgCo2e: number;
  distributionKgCo2e: number;
  suppliesFossilHeat: boolean;
  decarbonisationPlanInPlace?: boolean;
  /** Recovered heat or cooling from other users is attributed zero emissions (5.7.3.3). */
  recoveredHeatKgCo2e?: number;
}

export interface DistrictNetworkInput {
  networks: DistrictNetwork[];
  /** The 5.2.3.4 grid factor (all four lines) for the ORP year. */
  gridFactorKgCo2ePerKwh: number;
}

export interface SpaceHeatingInput {
  heatMetersInstalled: boolean;
  heatingDeliveredKwh?: number;
  coolingDeliveredKwh?: number;
  peakHeatingKw?: number;
  peakCoolingKw?: number;
  /** GIA of occupied spaces within the limited sectors (Table 18 note a). */
  occupiedGiaM2?: number;
  /** VRF systems whose delivery is calculated from submetered electricity (5.8.3). */
  vrfCalculated?: boolean;
}

export interface RefrigerantSystem {
  id: string;
  systemType: string;
  refrigerant: string;
  /** GWP from the DESNZ full set, kgCO2e per kg. */
  gwp: number;
  chargeKg: number;
  installDate?: string;
  kyoto?: boolean;
  /** Equation 9a inputs. */
  startChargeKg?: number;
  addedKg?: number;
  endChargeKg?: number;
  /** 5.9.6 exceptions. */
  exception?: "cannot_retrofit" | "installed_before_v1_no_works";
  leakDetectionFitted?: boolean;
}

export interface RefrigerantInput {
  systems: RefrigerantSystem[];
}

export interface CarbonCredit {
  scheme: "ICROA" | "ICVCM" | "other";
  vintageYear: number;
  tonnesCo2e: number;
  retired: boolean;
  registryReference?: string;
  supplier?: string;
}

export interface RenewableProcurement {
  type: "ukgbc_silver_or_gold" | "deep_green_rego_tariff" | "direct_ppa";
  kwhCovered: number;
  /** Fraction of the ORP the contract covers, 0 to 1. */
  orpCoverage: number;
  confirmedByExpert?: boolean;
  ppaWithinThreeYearsOfConstruction?: boolean;
  regosRetired?: boolean;
}

export interface OffsetInput {
  /** 5.10.1.2 total: upfront, operational energy, water, refrigerant leakage. */
  inScopeEmissionsKgCo2e: number;
  /** Scope 2 electricity emissions that renewable procurement may cover. */
  gridElectricityScope2KgCo2e?: number;
  credits: CarbonCredit[];
  procurement?: RenewableProcurement[];
}

export interface OperationalInputs {
  energy?: OperationalEnergyInput;
  renewables?: RenewablesInput;
  water?: WaterInput;
  fossilFuels?: FossilFuelInput;
  demand?: DemandInput;
  districtNetworks?: DistrictNetworkInput;
  spaceHeating?: SpaceHeatingInput;
  refrigerants?: RefrigerantInput;
  offsets?: OffsetInput;
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

export type AspectId =
  | "classification"
  | "embodied_carbon"
  | "operational_energy"
  | "onsite_renewables"
  | "operational_water"
  | "fossil_fuel_free"
  | "electricity_demand_management"
  | "district_networks"
  | "space_heating_cooling"
  | "refrigerants"
  | "carbon_offsetting";

/**
 * pass / fail: a pass-fail metric compared with its limit.
 * reported: a reporting metric with a value.
 * not_assessable: the Standard needs this but the inputs cannot give it.
 * not_applicable: the Standard does not require this for the building.
 */
export type FindingStatus = "pass" | "fail" | "reported" | "not_assessable" | "not_applicable";

export interface Finding {
  id: string;
  /** Section of the Standard the rule comes from. */
  section: string;
  kind: "pass_fail" | "reporting" | "requirement";
  metric: string;
  status: FindingStatus;
  value: number | null;
  limit: number | null;
  unit: string;
  /** value minus limit for pass-fail findings; positive is above the limit. */
  gap: number | null;
  reason: string;
  /** How the value was derived, for the submission statement. */
  basis?: string;
}

export interface AspectResult {
  aspect: AspectId;
  section: string;
  title: string;
  /** Worst of the pass-fail findings: fail > not_assessable > pass; not_applicable when nothing applies. */
  status: FindingStatus;
  findings: Finding[];
  warnings: string[];
}
