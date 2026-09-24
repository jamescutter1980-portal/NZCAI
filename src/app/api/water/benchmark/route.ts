import { NextResponse } from "next/server";
import { z } from "zod";
import {
  BENCHMARK_PROPERTY_TYPES,
  estimateConsumption,
  WATER_BENCHMARKS,
  type BenchmarkPropertyType,
} from "@/lib/water";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  propertyType: z.enum(BENCHMARK_PROPERTY_TYPES as [BenchmarkPropertyType, ...BenchmarkPropertyType[]]),
  floorAreaM2: z.coerce.number().positive().optional(),
  occupants: z.coerce.number().positive().optional(),
  days: z.coerce.number().positive().max(3660).optional(),
});

/** Indicative UK property water-use estimate (not a meter reading). */
export async function GET(req: Request) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid query",
        issues: parsed.error.issues,
        propertyTypes: BENCHMARK_PROPERTY_TYPES,
        benchmarks: Object.values(WATER_BENCHMARKS).map((b) => ({
          propertyType: b.propertyType,
          label: b.label,
          litresPerPersonPerDay: b.litresPerPersonPerDay,
          m3PerM2PerYear: b.m3PerM2PerYear,
        })),
      },
      { status: 400 },
    );
  }
  return NextResponse.json({
    estimate: estimateConsumption(parsed.data),
    attribution: "Indicative UK screening benchmarks for planning only; not measured consumption.",
  });
}
