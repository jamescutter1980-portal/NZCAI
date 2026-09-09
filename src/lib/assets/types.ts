import { z } from "zod";

const optionalText = (max: number) => z.preprocess((v) => (v === "" || v === null ? undefined : v), z.string().max(max).optional());
const optionalNumber = z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : Number(v)), z.number().optional());

export const assetCreateSchema = z.object({
  name: z.string().min(1).max(200),
  uprn: z.preprocess((v) => (v === "" || v === null ? undefined : String(v).trim()), z.string().regex(/^\d{1,12}$/, "UPRN must be up to 12 digits").optional()),
  address: optionalText(300),
  postcode: z.preprocess(
    (v) => (v === "" || v === null ? undefined : String(v).toUpperCase().replace(/\s+/g, "")),
    z.string().regex(/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/, "not a UK postcode").optional(),
  ),
  latitude: optionalNumber.pipe(z.number().min(-90).max(90).optional()),
  longitude: optionalNumber.pipe(z.number().min(-180).max(180).optional()),
  floorAreaM2: optionalNumber.pipe(z.number().positive().optional()),
  propertyType: optionalText(80),
  country: optionalText(40),
  notes: optionalText(2000),
});
export type AssetCreate = z.infer<typeof assetCreateSchema>;

export const assetUpdateSchema = assetCreateSchema.partial().refine((v) => Object.keys(v).length > 0, "no fields to update");
export type AssetUpdate = z.infer<typeof assetUpdateSchema>;

export interface AssetRecord extends AssetCreate {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export const assetMeterSchema = z.object({
  mpxn: z.string().trim().regex(/^\d{6,13}$/, "MPxN must be 6 to 13 digits"),
  utility: z.enum(["electricity", "gas"]),
  direction: z.enum(["import", "export"]).default("import"),
  label: optionalText(120),
  /** Supplier-specific factor for market-based Scope 2, kgCO2e/kWh, with evidence. */
  supplierFactorKgCo2ePerKwh: optionalNumber.pipe(z.number().min(0).optional()),
  supplierFactorEvidence: optionalText(300),
});
export type AssetMeterInput = z.infer<typeof assetMeterSchema>;

export interface AssetMeter extends AssetMeterInput {
  assetId: string;
  createdAt: string;
}

/** Postcode-formatted for display: "SW1A1AA" -> "SW1A 1AA". */
export function formatPostcode(pc?: string): string | undefined {
  if (!pc) return undefined;
  const c = pc.replace(/\s+/g, "").toUpperCase();
  return c.length > 3 ? `${c.slice(0, -3)} ${c.slice(-3)}` : c;
}
