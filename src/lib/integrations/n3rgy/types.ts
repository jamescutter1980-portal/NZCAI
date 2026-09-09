import { z } from "zod";

export const utilitySchema = z.enum(["electricity", "gas"]);
export type Utility = z.infer<typeof utilitySchema>;

export const granularitySchema = z.enum(["halfhour", "daily"]);
export type Granularity = z.infer<typeof granularitySchema>;

export type ReadingType = "consumption" | "tariff" | "production";

const cacheRangeSchema = z.object({ start: z.string(), end: z.string() });

export const consumptionValueSchema = z.object({
  timestamp: z.string(),
  value: z.number(),
  status: z.string().optional(),
});

/** Raw consumption or production response. Unknown fields are kept. */
export const rawConsumptionSchema = z
  .object({
    resource: z.string(),
    responseTimestamp: z.string(),
    start: z.string(),
    end: z.string(),
    granularity: z.string(),
    unit: z.string(),
    values: z.array(consumptionValueSchema),
    availableCacheRange: cacheRangeSchema.optional(),
    message: z.string().optional(),
  })
  .loose();
export type RawConsumption = z.infer<typeof rawConsumptionSchema>;

export const rawTariffSchema = z
  .object({
    resource: z.string(),
    responseTimestamp: z.string(),
    start: z.string(),
    end: z.string(),
    values: z.array(
      z
        .object({
          additionalInformation: z.string().optional(),
          standingCharges: z.array(z.object({ startDate: z.string(), value: z.number() })),
          prices: z.array(z.object({ timestamp: z.string(), value: z.number() })),
        })
        .loose(),
    ),
    availableCacheRange: cacheRangeSchema.optional(),
    message: z.string().optional(),
  })
  .loose();
export type RawTariff = z.infer<typeof rawTariffSchema>;

/** Listing endpoints return an entries array of resource names. */
export const rawListingSchema = z
  .object({
    resource: z.string().optional(),
    responseTimestamp: z.string().optional(),
    entries: z.array(z.string()),
  })
  .loose();
export type RawListing = z.infer<typeof rawListingSchema>;

export const rawFindMpxnSchema = z.object({}).loose();
export type RawFindMpxn = z.infer<typeof rawFindMpxnSchema>;
