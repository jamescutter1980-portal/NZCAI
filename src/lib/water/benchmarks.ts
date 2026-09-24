/**
 * Indicative UK property water-use benchmarks for screening when no meter
 * reads exist. Figures are order-of-magnitude planning values drawn from
 * published Waterwise / DEFRA / BREEAM-style guidance, not site measurements.
 * Always mark results as basis "estimated".
 */

export type BenchmarkPropertyType =
  | "office"
  | "retail"
  | "warehouse"
  | "hotel"
  | "restaurant"
  | "school"
  | "hospital"
  | "industrial"
  | "residential"
  | "mixed_use";

export interface WaterBenchmark {
  propertyType: BenchmarkPropertyType;
  label: string;
  /** Litres per person (or FTE / guest / pupil) per day, where occupancy is known. */
  litresPerPersonPerDay?: number;
  /** Cubic metres per m² of GIA per year, for area-based screening. */
  m3PerM2PerYear: number;
  source: string;
  notes: string;
}

export const WATER_BENCHMARKS: Record<BenchmarkPropertyType, WaterBenchmark> = {
  office: {
    propertyType: "office",
    label: "Office",
    litresPerPersonPerDay: 50,
    m3PerM2PerYear: 0.6,
    source: "Indicative UK commercial benchmarks (Waterwise / BREEAM-style)",
    notes: "Includes WC, washbasin and tea-point use. Process cooling and catering push this higher.",
  },
  retail: {
    propertyType: "retail",
    label: "Retail",
    litresPerPersonPerDay: 40,
    m3PerM2PerYear: 0.8,
    source: "Indicative UK commercial benchmarks",
    notes: "Staff-dominated; food retail and washrooms raise consumption.",
  },
  warehouse: {
    propertyType: "warehouse",
    label: "Warehouse / logistics",
    litresPerPersonPerDay: 25,
    m3PerM2PerYear: 0.2,
    source: "Indicative UK commercial benchmarks",
    notes: "Low occupancy density. Vehicle wash and process use are excluded.",
  },
  hotel: {
    propertyType: "hotel",
    label: "Hotel",
    litresPerPersonPerDay: 300,
    m3PerM2PerYear: 2.5,
    source: "Indicative UK hospitality benchmarks",
    notes: "Per occupied room / guest-night when occupancy is known.",
  },
  restaurant: {
    propertyType: "restaurant",
    label: "Restaurant / catering",
    litresPerPersonPerDay: 20,
    m3PerM2PerYear: 3.5,
    source: "Indicative UK hospitality benchmarks",
    notes: "Kitchen and dishwashing dominate; covers covers rather than staff.",
  },
  school: {
    propertyType: "school",
    label: "School / education",
    litresPerPersonPerDay: 15,
    m3PerM2PerYear: 0.9,
    source: "Indicative UK education benchmarks",
    notes: "Per pupil. Sports facilities and boarding raise this.",
  },
  hospital: {
    propertyType: "hospital",
    label: "Hospital / healthcare",
    litresPerPersonPerDay: 500,
    m3PerM2PerYear: 4.0,
    source: "Indicative UK healthcare benchmarks",
    notes: "Per occupied bed. Highly variable by clinical specialty.",
  },
  industrial: {
    propertyType: "industrial",
    label: "Industrial / manufacturing",
    litresPerPersonPerDay: 50,
    m3PerM2PerYear: 1.5,
    source: "Indicative UK industrial benchmarks",
    notes: "Domestic-style use only. Process water must be metered separately.",
  },
  residential: {
    propertyType: "residential",
    label: "Residential (household)",
    litresPerPersonPerDay: 140,
    m3PerM2PerYear: 1.0,
    source: "UK average household use (circa 140 l/person/day)",
    notes: "Household supply sits outside the MOSL non-household market.",
  },
  mixed_use: {
    propertyType: "mixed_use",
    label: "Mixed use",
    litresPerPersonPerDay: 60,
    m3PerM2PerYear: 1.0,
    source: "Blended commercial screening figure",
    notes: "Prefer a measured split by demise when available.",
  },
};

export const BENCHMARK_PROPERTY_TYPES = Object.keys(WATER_BENCHMARKS) as BenchmarkPropertyType[];

export interface BenchmarkEstimateInput {
  propertyType: BenchmarkPropertyType;
  floorAreaM2?: number;
  occupants?: number;
  /** Days in the period; defaults to 365. */
  days?: number;
}

export interface BenchmarkEstimate {
  propertyType: BenchmarkPropertyType;
  label: string;
  m3: number;
  method: "area" | "occupancy" | "unavailable";
  litresPerPersonPerDay?: number;
  m3PerM2PerYear?: number;
  days: number;
  source: string;
  notes: string;
  warnings: string[];
}

/** Estimate period consumption from area and/or occupancy. Occupancy wins when both given. */
export function estimateConsumption(input: BenchmarkEstimateInput): BenchmarkEstimate {
  const bench = WATER_BENCHMARKS[input.propertyType];
  const days = input.days && input.days > 0 ? input.days : 365;
  const warnings: string[] = [
    "Estimated only — replace with meter reads, retailer bills or consented MOSL/CMOS data before reporting.",
  ];

  if (input.occupants !== undefined && input.occupants > 0 && bench.litresPerPersonPerDay !== undefined) {
    const m3 = Math.round(((input.occupants * bench.litresPerPersonPerDay * days) / 1000) * 1000) / 1000;
    return {
      propertyType: bench.propertyType,
      label: bench.label,
      m3,
      method: "occupancy",
      litresPerPersonPerDay: bench.litresPerPersonPerDay,
      m3PerM2PerYear: bench.m3PerM2PerYear,
      days,
      source: bench.source,
      notes: bench.notes,
      warnings,
    };
  }

  if (input.floorAreaM2 !== undefined && input.floorAreaM2 > 0) {
    const m3 = Math.round(input.floorAreaM2 * bench.m3PerM2PerYear * (days / 365) * 1000) / 1000;
    return {
      propertyType: bench.propertyType,
      label: bench.label,
      m3,
      method: "area",
      litresPerPersonPerDay: bench.litresPerPersonPerDay,
      m3PerM2PerYear: bench.m3PerM2PerYear,
      days,
      source: bench.source,
      notes: bench.notes,
      warnings,
    };
  }

  return {
    propertyType: bench.propertyType,
    label: bench.label,
    m3: 0,
    method: "unavailable",
    litresPerPersonPerDay: bench.litresPerPersonPerDay,
    m3PerM2PerYear: bench.m3PerM2PerYear,
    days,
    source: bench.source,
    notes: bench.notes,
    warnings: [...warnings, "Provide floorAreaM2 or occupants to produce an estimate."],
  };
}
