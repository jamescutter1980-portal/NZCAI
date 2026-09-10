import { z } from "zod";

/**
 * Emission sources beyond meters and transport: refrigerants, water and waste.
 *
 * Same contract as transport. A row records a quantity and points at a
 * published DESNZ row by its id, so the portal holds no factor value of its
 * own and every figure can be traced back to the row it came from.
 */
const optionalText = (max: number) => z.preprocess((v) => (v === "" || v === null ? undefined : v), z.string().max(max).optional());
const optionalNumber = z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : Number(v)), z.number().optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

export interface CategoryMeta {
  label: string;
  scope: 1 | 3;
  ghgCategory: string;
  expectedScope: string;
  family: "refrigerant" | "water" | "waste";
  /** Waste only: whether this route counts as diverted from landfill. */
  diverted?: boolean;
  /** Stated where the GHG Protocol category is a reporting convention rather than a rule. */
  categoryNote?: string;
}

export const EMISSION_CATEGORIES: Record<string, CategoryMeta> = {
  refrigerant_topup: {
    label: "Refrigerant top-up or loss",
    scope: 1,
    ghgCategory: "Scope 1 fugitive emissions",
    expectedScope: "Scope 1",
    family: "refrigerant",
    categoryNote:
      "Mass-balance approach: the refrigerant added to a system over the period is taken as the quantity that leaked. Record top-ups from service records, not the system charge.",
  },
  water_supply: {
    label: "Water supplied",
    scope: 3,
    ghgCategory: "Category 1 purchased goods and services",
    expectedScope: "Scope 3",
    family: "water",
    categoryNote: "Water supply is commonly reported under category 1. Some organisations report supply and treatment together under category 5; state which you use.",
  },
  water_treatment: {
    label: "Water treated (wastewater)",
    scope: 3,
    ghgCategory: "Category 5 waste generated in operations",
    expectedScope: "Scope 3",
    family: "water",
    categoryNote: "Treated volume is often taken as a percentage of supply where no wastewater meter exists. Record which assumption you used in the evidence field.",
  },
  waste_landfill: { label: "Waste to landfill", scope: 3, ghgCategory: "Category 5 waste generated in operations", expectedScope: "Scope 3", family: "waste", diverted: false },
  waste_recycling: { label: "Waste to recycling", scope: 3, ghgCategory: "Category 5 waste generated in operations", expectedScope: "Scope 3", family: "waste", diverted: true },
  waste_combustion: { label: "Waste to energy recovery or combustion", scope: 3, ghgCategory: "Category 5 waste generated in operations", expectedScope: "Scope 3", family: "waste", diverted: true },
  waste_composting: { label: "Waste to composting", scope: 3, ghgCategory: "Category 5 waste generated in operations", expectedScope: "Scope 3", family: "waste", diverted: true },
  waste_anaerobic_digestion: { label: "Waste to anaerobic digestion", scope: 3, ghgCategory: "Category 5 waste generated in operations", expectedScope: "Scope 3", family: "waste", diverted: true },
  waste_reuse: { label: "Waste reused", scope: 3, ghgCategory: "Category 5 waste generated in operations", expectedScope: "Scope 3", family: "waste", diverted: true },
};

export type EmissionCategory = keyof typeof EMISSION_CATEGORIES;
export const EMISSION_CATEGORY_IDS = Object.keys(EMISSION_CATEGORIES) as [string, ...string[]];
export const BASES = ["measured", "estimated", "client_declared"] as const;

export const siteActivityCreateSchema = z
  .object({
    category: z.enum(EMISSION_CATEGORY_IDS),
    label: z.string().min(1).max(200),
    assetId: optionalText(64),
    periodStart: isoDate,
    periodEnd: isoDate,
    quantity: z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : Number(v)), z.number().nonnegative()),
    unit: z.string().min(1).max(40),
    /** Refrigerant rows: the gas, e.g. R410A. Used to pick the right GWP row. */
    refrigerantType: optionalText(40),
    /** Waste rows: the material, e.g. mixed commercial, paper, WEEE. */
    wasteMaterial: optionalText(80),
    factorId: optionalText(40),
    factorYear: optionalNumber.pipe(z.number().int().min(2000).max(2100).optional()),
    basis: z.enum(BASES).default("client_declared"),
    evidence: optionalText(300),
    notes: optionalText(1000),
  })
  .refine((v) => v.periodEnd >= v.periodStart, { message: "periodEnd must not be before periodStart", path: ["periodEnd"] })
  .refine((v) => (v.factorId ? v.factorYear !== undefined : true), { message: "factorYear is required when a factor is chosen", path: ["factorYear"] });
export type SiteActivityCreate = z.infer<typeof siteActivityCreateSchema>;

export const siteActivityUpdateSchema = z.object({
  category: z.enum(EMISSION_CATEGORY_IDS).optional(),
  label: z.string().min(1).max(200).optional(),
  assetId: optionalText(64),
  periodStart: isoDate.optional(),
  periodEnd: isoDate.optional(),
  quantity: optionalNumber.pipe(z.number().nonnegative().optional()),
  unit: z.string().min(1).max(40).optional(),
  refrigerantType: optionalText(40),
  wasteMaterial: optionalText(80),
  factorId: optionalText(40),
  factorYear: optionalNumber.pipe(z.number().int().min(2000).max(2100).optional()),
  basis: z.enum(BASES).optional(),
  evidence: optionalText(300),
  notes: optionalText(1000),
});
export type SiteActivityUpdate = z.infer<typeof siteActivityUpdateSchema>;

export interface SiteActivityRecord extends SiteActivityCreate {
  id: string;
  createdAt: string;
  updatedAt: string;
}
