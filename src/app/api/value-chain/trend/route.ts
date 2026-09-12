import { NextResponse } from "next/server";
import { periodFromSearchParams } from "@/lib/carbon";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";
import { BaselineRepository, RestatementRepository, baselineSchema, restatementSchema, valueChainTrend } from "@/lib/value-chain";

export const dynamic = "force-dynamic";

/** Value chain emissions over time, with the headline change separated from like-for-like movement. */
export function GET(req: Request) {
  const p = periodFromSearchParams(req.url);
  if (!p.ok) return NextResponse.json({ error: p.error, issues: p.issues }, { status: 400 });
  const from = new URL(req.url).searchParams.get("from");
  const years = from ? range(Number(from), Number(p.period.from.slice(0, 4))) : undefined;
  if (years && years.some((y) => !Number.isFinite(y))) return NextResponse.json({ error: "from must be a year" }, { status: 400 });
  return NextResponse.json(valueChainTrend(getDb(), defaultContext(), p.period, { years }));
}

/** Sets the baseline year, or records a restatement of a year already published. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const kind = (body as { kind?: string })?.kind;
  const db = getDb();
  if (kind === "restatement") {
    const parsed = restatementSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid restatement", issues: parsed.error.issues }, { status: 400 });
    return NextResponse.json({ restatement: new RestatementRepository(db).create(parsed.data) }, { status: 201 });
  }
  const parsed = baselineSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid baseline", issues: parsed.error.issues }, { status: 400 });
  return NextResponse.json({ baseline: new BaselineRepository(db).set(parsed.data) }, { status: 201 });
}

/** Clears the baseline, or a single restatement by id. */
export function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("restatementId");
  const db = getDb();
  if (id) new RestatementRepository(db).delete(id);
  else new BaselineRepository(db).clear();
  return new NextResponse(null, { status: 204 });
}

const range = (from: number, to: number) => (to < from ? [from] : Array.from({ length: to - from + 1 }, (_, i) => from + i));
