import { NextResponse } from "next/server";
import { periodFromSearchParams } from "@/lib/carbon";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";
import { hotspotScreen, valueChainReport } from "@/lib/value-chain";

export const dynamic = "force-dynamic";

/** Active counterparties ranked by their best available figure, with the priority set marked. */
export function GET(req: Request) {
  const p = periodFromSearchParams(req.url);
  if (!p.ok) return NextResponse.json({ error: p.error, issues: p.issues }, { status: 400 });
  const raw = new URL(req.url).searchParams.get("threshold");
  const thresholdPct = raw === null ? undefined : Number(raw);
  if (thresholdPct !== undefined && (!Number.isFinite(thresholdPct) || thresholdPct <= 0 || thresholdPct > 100)) {
    return NextResponse.json({ error: "threshold must be a percentage above 0 and no more than 100" }, { status: 400 });
  }
  const db = getDb();
  return NextResponse.json(hotspotScreen(valueChainReport(db, defaultContext(), p.period), { thresholdPct }));
}
