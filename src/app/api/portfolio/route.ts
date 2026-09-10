import { NextResponse } from "next/server";
import { periodFromSearchParams, portfolioReport } from "@/lib/carbon";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";
import { transportCarbon } from "@/lib/transport";
import { emissionsCarbon } from "@/lib/emissions";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Portfolio roll-up for a reporting period. */
export function GET(req: Request) {
  const p = periodFromSearchParams(req.url);
  if (!p.ok) return NextResponse.json({ error: p.error, issues: p.issues }, { status: 400 });
  const db = getDb();
  const ctx = defaultContext();
  // Transport is organisation-level, so it sits alongside the per-asset roll-up rather than inside it.
  return NextResponse.json({
    ...portfolioReport(db, ctx, p.period),
    transport: transportCarbon(db, ctx, p.period),
    siteEmissions: emissionsCarbon(db, ctx, p.period),
  });
}
