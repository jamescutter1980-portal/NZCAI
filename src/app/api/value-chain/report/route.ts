import { NextResponse } from "next/server";
import { periodFromSearchParams } from "@/lib/carbon";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";
import { valueChainReport } from "@/lib/value-chain";

export const dynamic = "force-dynamic";

/** Every counterparty for the period: engagement state, attributable tCO2e with tier, coverage and the ranked plan. */
export function GET(req: Request) {
  const p = periodFromSearchParams(req.url);
  if (!p.ok) return NextResponse.json({ error: p.error, issues: p.issues }, { status: 400 });
  return NextResponse.json(valueChainReport(getDb(), defaultContext(), p.period));
}
