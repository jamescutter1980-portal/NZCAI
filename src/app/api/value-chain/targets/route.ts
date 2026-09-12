import { NextResponse } from "next/server";
import { periodFromSearchParams } from "@/lib/carbon";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";
import { TargetRepository, periodForYear, targetCreateSchema, targetReport, valueChainReport, valueChainTrend } from "@/lib/value-chain";

export const dynamic = "force-dynamic";

/** Targets with progress against the straight line, and the initiative pipeline behind them. */
export function GET(req: Request) {
  const p = periodFromSearchParams(req.url);
  if (!p.ok) return NextResponse.json({ error: p.error, issues: p.issues }, { status: 400 });
  const db = getDb();
  const ctx = defaultContext();
  const trend = valueChainTrend(db, ctx, p.period);
  const valueGbpByYear: Record<number, number> = {};
  for (const y of trend.years) valueGbpByYear[y.reportingYear] = valueChainReport(db, ctx, periodForYear(y.reportingYear, p.period)).coverage.valueTotalGbp;
  return NextResponse.json({ ...targetReport(db, trend, { valueGbpByYear }), targets: new TargetRepository(db).list() });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = targetCreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid target", issues: parsed.error.issues }, { status: 400 });
  return NextResponse.json({ target: new TargetRepository(getDb()).create(parsed.data) }, { status: 201 });
}
