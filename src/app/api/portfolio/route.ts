import { NextResponse } from "next/server";
import { periodFromSearchParams, portfolioReport } from "@/lib/carbon";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";
import { transportCarbon } from "@/lib/transport";
import { emissionsCarbon } from "@/lib/emissions";
import { clientScope, resolveAccess } from "@/lib/api-keys";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Portfolio roll-up for a reporting period. */
export function GET(req: Request) {
  const db = getDb();
  const auth = resolveAccess(req, db);
  if (!auth.ok) return auth.response;
  const p = periodFromSearchParams(req.url);
  if (!p.ok) return NextResponse.json({ error: p.error, issues: p.issues }, { status: 400 });
  const ctx = defaultContext();
  // A client key gets its own assets and nothing organisation-wide.
  if (auth.access.kind === "client") return NextResponse.json(portfolioReport(db, ctx, p.period, clientScope(auth.access)));
  // Transport is organisation-level, so it sits alongside the per-asset roll-up rather than inside it.
  return NextResponse.json({
    ...portfolioReport(db, ctx, p.period),
    transport: transportCarbon(db, ctx, p.period),
    siteEmissions: emissionsCarbon(db, ctx, p.period),
  });
}
