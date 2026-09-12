import { z } from "zod";
import { resolvePeriod, type Period } from "./period";

export const periodQuerySchema = z.object({
  kind: z.enum(["calendar", "fiscal", "rolling12"]).default("calendar"),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  startMonth: z.coerce.number().int().min(1).max(12).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  factorYear: z.coerce.number().int().min(2000).max(2100).optional(),
});

export type PeriodParseResult = { ok: true; period: Period } | { ok: false; error: string; issues?: z.core.$ZodIssue[] };

/** Reads period parameters from a URL, defaulting to the last complete calendar year. */
export function periodFromSearchParams(url: string): PeriodParseResult {
  const raw = Object.fromEntries(new URL(url).searchParams);
  const parsed = periodQuerySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid period", issues: parsed.error.issues };
  try {
    return { ok: true, period: resolvePeriod(parsed.data) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
