import { NextResponse } from "next/server";
import { z } from "zod";
import { enrichVehicle } from "@/lib/transport/enrichment";

/**
 * POST /api/transport/enrich
 *
 * Body: { registration: string, includeMot?: boolean }
 *
 * 200 with the EnrichmentResult whenever the enrichment ran, including when
 * every source failed: the result carries `sources` and `warnings` that say so,
 * which is more useful to a caller than an error status. 400 for an invalid
 * registration. 503 only if nothing at all could run. Never 500 for an upstream
 * failure.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.object({
  registration: z.string(),
  includeMot: z.boolean().optional(),
});

export async function POST(req: Request) {
  let parsedBody: unknown;
  const text = await req.text();
  try {
    parsedBody = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Body must be { registration: string, includeMot?: boolean }", issues: parsed.error.issues }, { status: 400 });
  }

  try {
    const result = await enrichVehicle(parsed.data.registration, undefined, { includeMot: parsed.data.includeMot });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof RangeError) return NextResponse.json({ error: e.message }, { status: 400 });
    // enrichVehicle absorbs every source failure, so reaching here means the
    // enrichment itself could not run at all.
    return NextResponse.json({ error: `Vehicle enrichment could not run: ${e instanceof Error ? e.message : String(e)}` }, { status: 503 });
  }
}
