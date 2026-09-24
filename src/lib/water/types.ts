import { z } from "zod";
import { BENCHMARK_PROPERTY_TYPES } from "./benchmarks";

/**
 * Water supply points and consumption for UK properties.
 *
 * England's non-household market identifies supply points with SPIDs held in
 * CMOS (MOSL). Household and Welsh supplies sit outside that market but still
 * need a place in the portal, so the identifier field accepts a SPID or any
 * stable meter / account reference the client uses.
 */

const optionalText = (max: number) => z.preprocess((v) => (v === "" || v === null ? undefined : v), z.string().max(max).optional());
const optionalNumber = z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : Number(v)), z.number().optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

/** CMOS SPIDs are 10 digits; we also accept broader meter / account refs. */
export const SPID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{5,19}$/;

export const WATER_SERVICES = ["water", "sewerage", "water_and_sewerage"] as const;
export type WaterService = (typeof WATER_SERVICES)[number];

export const WATER_BASES = ["measured", "estimated", "client_declared"] as const;
export type WaterBasis = (typeof WATER_BASES)[number];

export const WATER_SOURCES = ["bill", "retailer_portal", "mosl_cmos", "amr_meter", "manual", "benchmark"] as const;
export type WaterSource = (typeof WATER_SOURCES)[number];

export const supplyPointCreateSchema = z.object({
  spid: z.preprocess((v) => String(v ?? "").trim().toUpperCase().replace(/\s+/g, ""), z.string().regex(SPID_PATTERN, "SPID or meter ref must be 6–20 letters, digits or hyphens")),
  service: z.enum(WATER_SERVICES).default("water"),
  label: optionalText(120),
  assetId: optionalText(64),
  postcode: z.preprocess(
    (v) => (v === "" || v === null ? undefined : String(v).toUpperCase().replace(/\s+/g, "")),
    z.string().regex(/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/, "not a UK postcode").optional(),
  ),
  address: optionalText(300),
  retailerId: optionalText(80),
  wholesalerId: optionalText(80),
  propertyType: z.enum(BENCHMARK_PROPERTY_TYPES as [string, ...string[]]).optional(),
  floorAreaM2: optionalNumber.pipe(z.number().positive().optional()),
  occupants: optionalNumber.pipe(z.number().positive().optional()),
  consentRef: optionalText(120),
  notes: optionalText(2000),
});
export type SupplyPointCreate = z.infer<typeof supplyPointCreateSchema>;

export const supplyPointUpdateSchema = supplyPointCreateSchema
  .omit({ spid: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "no fields to update");
export type SupplyPointUpdate = z.infer<typeof supplyPointUpdateSchema>;

export interface SupplyPointRecord extends SupplyPointCreate {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export const consumptionCreateSchema = z
  .object({
    supplyPointId: z.string().min(1).max(64),
    periodStart: isoDate,
    periodEnd: isoDate,
    volumeM3: z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : Number(v)), z.number().nonnegative()),
    basis: z.enum(WATER_BASES).default("client_declared"),
    source: z.enum(WATER_SOURCES).default("manual"),
    evidence: optionalText(300),
    readingStart: optionalNumber.pipe(z.number().nonnegative().optional()),
    readingEnd: optionalNumber.pipe(z.number().nonnegative().optional()),
    unitCostGbpPerM3: optionalNumber.pipe(z.number().nonnegative().optional()),
    notes: optionalText(1000),
  })
  .refine((v) => v.periodEnd >= v.periodStart, { message: "periodEnd must not be before periodStart", path: ["periodEnd"] });
export type ConsumptionCreate = z.infer<typeof consumptionCreateSchema>;

export const consumptionUpdateSchema = z
  .object({
    periodStart: isoDate.optional(),
    periodEnd: isoDate.optional(),
    volumeM3: optionalNumber.pipe(z.number().nonnegative().optional()),
    basis: z.enum(WATER_BASES).optional(),
    source: z.enum(WATER_SOURCES).optional(),
    evidence: optionalText(300),
    readingStart: optionalNumber.pipe(z.number().nonnegative().optional()),
    readingEnd: optionalNumber.pipe(z.number().nonnegative().optional()),
    unitCostGbpPerM3: optionalNumber.pipe(z.number().nonnegative().optional()),
    notes: optionalText(1000),
  })
  .refine((v) => Object.keys(v).length > 0, "no fields to update")
  .refine((v) => (v.periodStart && v.periodEnd ? v.periodEnd >= v.periodStart : true), {
    message: "periodEnd must not be before periodStart",
    path: ["periodEnd"],
  });
export type ConsumptionUpdate = z.infer<typeof consumptionUpdateSchema>;

export interface ConsumptionRecord extends ConsumptionCreate {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export function formatPostcode(pc?: string): string | undefined {
  if (!pc) return undefined;
  const c = pc.replace(/\s+/g, "").toUpperCase();
  return c.length > 3 ? `${c.slice(0, -3)} ${c.slice(-3)}` : c;
}

/** Convert common volume units to m³. */
export function toM3(quantity: number, unit: string): number | null {
  const u = unit.trim().toLowerCase().replace(/\s+/g, "");
  if (u === "m3" || u === "m³" || u === "cum" || u === "cubicmetres" || u === "cubicmeter" || u === "cubicmetre") return quantity;
  if (u === "l" || u === "litre" || u === "litres" || u === "liter" || u === "liters") return quantity / 1000;
  if (u === "ml") return quantity / 1_000_000;
  if (u === "gal" || u === "gallon" || u === "gallons" || u === "ukgal") return quantity * 0.00454609;
  return null;
}
