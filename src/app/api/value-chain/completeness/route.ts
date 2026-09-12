import { NextResponse } from "next/server";
import { periodFromSearchParams } from "@/lib/carbon";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";
import { CategoryAssessmentRepository, categoryAssessmentSchema, categoryCompleteness, valueChainReport } from "@/lib/value-chain";

export const dynamic = "force-dynamic";

/** All fifteen Scope 3 categories with their assessment, what the register holds and what is still open. */
export function GET(req: Request) {
  const p = periodFromSearchParams(req.url);
  if (!p.ok) return NextResponse.json({ error: p.error, issues: p.issues }, { status: 400 });
  const db = getDb();
  return NextResponse.json(categoryCompleteness(db, valueChainReport(db, defaultContext(), p.period)));
}

/** Records the assessment of one category, or carries a whole year forward. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const db = getDb();
  const roll = body as { kind?: string; fromYear?: number; toYear?: number };
  if (roll?.kind === "roll_forward") {
    if (!Number.isInteger(roll.fromYear) || !Number.isInteger(roll.toYear)) return NextResponse.json({ error: "fromYear and toYear are required" }, { status: 400 });
    return NextResponse.json({ carried: new CategoryAssessmentRepository(db).rollForward(roll.fromYear!, roll.toYear!) }, { status: 201 });
  }
  const parsed = categoryAssessmentSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid assessment", issues: parsed.error.issues }, { status: 400 });
  return NextResponse.json({ assessment: new CategoryAssessmentRepository(db).upsert(parsed.data) }, { status: 201 });
}
