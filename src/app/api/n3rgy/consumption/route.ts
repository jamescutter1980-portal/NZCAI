import { NextResponse } from "next/server";
import { z } from "zod";
import { ConsentError, getConsentStore, requireActiveConsent } from "@/lib/consent";
import {
  dailyTotals,
  granularitySchema,
  N3rgyApiError,
  N3rgyClient,
  N3rgyConfigError,
  normaliseConsumption,
  utilitySchema,
} from "@/lib/integrations/n3rgy";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  mpxn: z.string().regex(/^\d{6,13}$/, "MPxN must be 6 to 13 digits"),
  utility: utilitySchema,
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "start must be YYYY-MM-DD"),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "end must be YYYY-MM-DD"),
  granularity: granularitySchema.default("halfhour"),
  direction: z.enum(["import", "export"]).default("import"),
});

/**
 * Server-side proxy to n3rgy. The key never reaches the browser. Dates are
 * whole UTC days, inclusive. Live retrieval requires an active consent record
 * for the MPxN and utility; sandbox retrieval does not.
 */
export async function GET(req: Request) {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query", issues: parsed.error.issues }, { status: 400 });
  }
  const q = parsed.data;
  const start = new Date(`${q.start}T00:00:00Z`);
  const end = new Date(`${q.end}T23:59:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
  }

  try {
    const client = new N3rgyClient();
    const gate = await requireActiveConsent(getConsentStore(), q.mpxn, q.utility, {
      sandbox: client.environment === "sandbox",
    });
    const query = { mpxn: q.mpxn, utility: q.utility, start, end, granularity: q.granularity };
    const raw = q.direction === "export" ? await client.getProduction(query) : await client.getConsumption(query);
    const readings = normaliseConsumption(query, raw, { direction: q.direction, consentRef: gate.consentRef });
    return NextResponse.json({
      environment: client.environment,
      consentRef: gate.consentRef,
      partial: raw.partial,
      retrievedAt: raw.retrievedAt,
      count: readings.length,
      unit: readings[0]?.unit ?? null,
      attribution: readings[0]?.provenance.attribution ?? null,
      daily: dailyTotals(readings),
      readings,
    });
  } catch (e) {
    if (e instanceof N3rgyConfigError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    if (e instanceof ConsentError) {
      return NextResponse.json({ error: e.message, consentCode: e.code, consentId: e.consentId }, { status: 403 });
    }
    if (e instanceof N3rgyApiError) {
      return NextResponse.json({ error: e.message, upstreamStatus: e.status }, { status: 502 });
    }
    if (e instanceof RangeError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
