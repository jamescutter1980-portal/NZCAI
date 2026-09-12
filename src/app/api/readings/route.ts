import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/sqlite";
import { ReadingsRepository } from "@/lib/db/readings-repo";
import { dailyTotals, readingsToCsv } from "@/lib/integrations/n3rgy";
import { estimateCost, findGaps } from "@/lib/sync";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  mpxn: z.string().regex(/^\d{6,13}$/),
  utility: z.enum(["electricity", "gas"]),
  direction: z.enum(["import", "export"]).default("import"),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  format: z.enum(["json", "csv"]).default("json"),
});

/** Stored readings for a meter over whole UTC days, with totals, gaps and an indicative cost. */
export async function GET(req: Request) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid query", issues: parsed.error.issues }, { status: 400 });
  const q = parsed.data;
  const from = `${q.start}T00:00:00.000Z`;
  const to = new Date(new Date(`${q.end}T00:00:00Z`).getTime() + 86_400_000).toISOString();
  if (to <= from) return NextResponse.json({ error: "end must not be before start" }, { status: 400 });

  const repo = new ReadingsRepository(getDb());
  const key = { mpxn: q.mpxn, utility: q.utility, direction: q.direction };
  const readings = repo.listReadings(key, from, to);
  if (q.format === "csv") {
    return new Response(readingsToCsv(readings), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${q.mpxn}-${q.utility}-${q.direction}-${q.start}-${q.end}.csv"`,
      },
    });
  }
  const prices = repo.listTariffPrices(key, from, to);
  const charges = repo.listStandingCharges(key);
  const cost = q.direction === "import" && readings.length > 0 ? estimateCost(readings, prices, charges) : null;
  const gaps = readings.length > 0 ? findGaps(readings.map((r) => r.intervalStart), readings[0].intervalStart, readings[readings.length - 1].intervalStart) : [];
  return NextResponse.json({
    ...key,
    from,
    to,
    count: readings.length,
    unit: readings[0]?.unit ?? null,
    total: Math.round(readings.reduce((n, r) => n + r.value, 0) * 1000) / 1000,
    daily: dailyTotals(readings),
    gaps,
    cost,
    attribution: readings[0]?.provenance.attribution ?? null,
    consentRefs: [...new Set(readings.map((r) => r.provenance.consentRef).filter(Boolean))],
  });
}
