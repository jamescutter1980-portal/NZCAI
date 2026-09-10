import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/sqlite";
import { activityCreateSchema, TransportRepository } from "@/lib/transport";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const repo = new TransportRepository(getDb());
  return NextResponse.json({
    activity: repo.listActivity({ from: p.get("from") ?? undefined, to: p.get("to") ?? undefined }),
  });
}

const batchSchema = z.object({ rows: z.array(activityCreateSchema).min(1).max(20_000) });

/** Accepts one activity or a batch from a CSV import. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const repo = new TransportRepository(getDb());
  const batch = batchSchema.safeParse(body);
  if (batch.success) {
    const created = repo.createActivityBatch(batch.data.rows);
    return NextResponse.json({ created: created.length, activity: created }, { status: 201 });
  }
  const one = activityCreateSchema.safeParse(body);
  if (!one.success) return NextResponse.json({ error: "Invalid activity", issues: one.error.issues }, { status: 400 });
  return NextResponse.json({ activity: repo.createActivity(one.data) }, { status: 201 });
}
