import { NextResponse } from "next/server";
import { periodFromSearchParams, portfolioReport } from "@/lib/carbon";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Portfolio roll-up for a reporting period. */
export function GET(req: Request) {
  const p = periodFromSearchParams(req.url);
  if (!p.ok) return NextResponse.json({ error: p.error, issues: p.issues }, { status: 400 });
  return NextResponse.json(portfolioReport(getDb(), defaultContext(), p.period));
}
