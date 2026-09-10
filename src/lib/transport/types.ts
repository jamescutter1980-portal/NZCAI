import { z } from "zod";

/**
 * Transport and business travel.
 *
 * An activity row records a quantity (distance, fuel, passenger-km, room-nights)
 * and points at a DESNZ conversion factor by its row id in the published flat
 * file for a reporting year. The portal never stores a factor value of its own,
 * so a figure can always be traced back to the published row it came from.
 */
const optionalText = (max: number) => z.preprocess((v) => (v === "" || v === null ? undefined : v), z.string().max(max).optional());
const optionalNumber = z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : Number(v)), z.number().optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

export const OWNERSHIPS = ["owned", "leased", "employee"] as const;
export type Ownership = (typeof OWNERSHIPS)[number];

export const vehicleCreateSchema = z.object({
  registration: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : String(v).toUpperCase().replace(/\s+/g, "")),
    z.string().regex(/^[A-Z0-9]{2,8}$/, "not a UK registration").optional(),
  ),
  make: optionalText(80),
  model: optionalText(120),
  /** As reported by DVLA, e.g. PETROL, DIESEL, ELECTRICITY, HYBRID ELECTRIC. */
  fuelType: optionalText(60),
  engineCapacityCc: optionalNumber.pipe(z.number().int().positive().optional()),
  /** Type-approval CO2, g/km. Context only; never used as a reporting factor. */
  co2GPerKm: optionalNumber.pipe(z.number().nonnegative().optional()),
  yearOfManufacture: optionalNumber.pipe(z.number().int().min(1900).max(2100).optional()),
  ownership: z.enum(OWNERSHIPS).default("owned"),
  enrichmentSource: optionalText(20),
  enrichedAt: optionalText(40),
  enrichmentDetail: optionalText(500),
  notes: optionalText(1000),
});
export type VehicleCreate = z.infer<typeof vehicleCreateSchema>;
export const vehicleUpdateSchema = vehicleCreateSchema.partial().refine((v) => Object.keys(v).length > 0, "no fields to update");
export type VehicleUpdate = z.infer<typeof vehicleUpdateSchema>;

export interface VehicleRecord extends VehicleCreate {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Activity categories and the GHG Protocol scope and category each belongs to.
 * This is the Protocol's own structure, not a portal judgement, and the DESNZ
 * row's Scope column is checked against it when a factor is chosen.
 */
export const TRANSPORT_CATEGORIES = {
  fleet_owned: { label: "Own or leased vehicles", scope: 1, ghgCategory: "Scope 1 mobile combustion", expectedScope: "Scope 1" },
  grey_fleet: { label: "Grey fleet (employee vehicles, business mileage)", scope: 3, ghgCategory: "Category 6 business travel", expectedScope: "Scope 3" },
  business_travel_air: { label: "Air travel", scope: 3, ghgCategory: "Category 6 business travel", expectedScope: "Scope 3" },
  business_travel_rail: { label: "Rail travel", scope: 3, ghgCategory: "Category 6 business travel", expectedScope: "Scope 3" },
  business_travel_road: { label: "Taxi, bus, hire car", scope: 3, ghgCategory: "Category 6 business travel", expectedScope: "Scope 3" },
  business_travel_sea: { label: "Ferry and sea travel", scope: 3, ghgCategory: "Category 6 business travel", expectedScope: "Scope 3" },
  hotel_stay: { label: "Hotel stays", scope: 3, ghgCategory: "Category 6 business travel", expectedScope: "Scope 3" },
  commuting: { label: "Employee commuting", scope: 3, ghgCategory: "Category 7 employee commuting", expectedScope: "Scope 3" },
  freight_upstream: { label: "Freight, upstream", scope: 3, ghgCategory: "Category 4 upstream transport", expectedScope: "Scope 3" },
  freight_downstream: { label: "Freight, downstream", scope: 3, ghgCategory: "Category 9 downstream transport", expectedScope: "Scope 3" },
  well_to_tank: { label: "Well-to-tank for transport fuel", scope: 3, ghgCategory: "Category 3 fuel and energy related", expectedScope: "Scope 3" },
} as const;

export type TransportCategory = keyof typeof TRANSPORT_CATEGORIES;
export const TRANSPORT_CATEGORY_IDS = Object.keys(TRANSPORT_CATEGORIES) as [TransportCategory, ...TransportCategory[]];

export const BASES = ["measured", "estimated", "client_declared"] as const;

export const activityCreateSchema = z
  .object({
    category: z.enum(TRANSPORT_CATEGORY_IDS),
    label: z.string().min(1).max(200),
    periodStart: isoDate,
    periodEnd: isoDate,
    assetId: optionalText(64),
    vehicleId: optionalText(64),
    quantity: z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : Number(v)), z.number().nonnegative()),
    /** Must match the chosen factor's unit, or convert to it (miles and km only). */
    unit: z.string().min(1).max(40),
    /** DESNZ flat-file row id, with the year whose file it came from. */
    factorId: optionalText(40),
    factorYear: optionalNumber.pipe(z.number().int().min(2000).max(2100).optional()),
    basis: z.enum(BASES).default("client_declared"),
    evidence: optionalText(300),
    notes: optionalText(1000),
  })
  .refine((v) => v.periodEnd >= v.periodStart, { message: "periodEnd must not be before periodStart", path: ["periodEnd"] })
  .refine((v) => (v.factorId ? v.factorYear !== undefined : true), { message: "factorYear is required when a factor is chosen", path: ["factorYear"] });
export type ActivityCreate = z.infer<typeof activityCreateSchema>;

export const activityUpdateSchema = z.object({
  category: z.enum(TRANSPORT_CATEGORY_IDS).optional(),
  label: z.string().min(1).max(200).optional(),
  periodStart: isoDate.optional(),
  periodEnd: isoDate.optional(),
  assetId: optionalText(64),
  vehicleId: optionalText(64),
  quantity: optionalNumber.pipe(z.number().nonnegative().optional()),
  unit: z.string().min(1).max(40).optional(),
  factorId: optionalText(40),
  factorYear: optionalNumber.pipe(z.number().int().min(2000).max(2100).optional()),
  basis: z.enum(BASES).optional(),
  evidence: optionalText(300),
  notes: optionalText(1000),
});
export type ActivityUpdate = z.infer<typeof activityUpdateSchema>;

export interface ActivityRecord extends ActivityCreate {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export { UNIT_CONVERSIONS, normaliseUnit, unitConversion } from "@/lib/carbon/units";
