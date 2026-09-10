import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/sqlite";
import { ActivityLedgerRepository, CounterpartyRepository, activityCreateSchema, type ActivityCreate } from "@/lib/value-chain";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const year = p.get("year");
  return NextResponse.json({
    activity: new ActivityLedgerRepository(getDb()).list({ counterpartyId: p.get("counterpartyId") ?? undefined, reportingYear: year ? Number(year) : undefined }),
  });
}

/**
 * A batch is the counterparty's ledger upload: the counterparty and reporting
 * year are given once and stamped on every row, so the template the
 * counterparty fills never has to carry them. All or nothing.
 */
const batchSchema = z.object({
  counterpartyId: z.string().min(1),
  reportingYear: z.coerce.number().int().min(2000).max(2100),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(20_000),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const db = getDb();
  const repo = new ActivityLedgerRepository(db);
  const counterparties = new CounterpartyRepository(db);
  const batch = batchSchema.safeParse(body);
  if (batch.success) {
    if (!counterparties.get(batch.data.counterpartyId)) return NextResponse.json({ error: "Counterparty not found" }, { status: 404 });
    const prepared: ActivityCreate[] = [];
    const issues: { row: number; message: string }[] = [];
    batch.data.rows.forEach((raw, i) => {
      const parsed = activityCreateSchema.safeParse({ ...raw, counterpartyId: batch.data.counterpartyId, reportingYear: batch.data.reportingYear });
      if (!parsed.success) issues.push({ row: i + 1, message: parsed.error.issues.map((x) => `${x.path.join(".") || "row"}: ${x.message}`).join("; ") });
      else prepared.push(parsed.data);
    });
    if (issues.length > 0) {
      return NextResponse.json({ error: `${issues.length} of ${batch.data.rows.length} rows are invalid; nothing was imported.`, issues: issues.slice(0, 50) }, { status: 400 });
    }
    const created = repo.createBatch(prepared);
    return NextResponse.json({ created: created.length, activity: created }, { status: 201 });
  }
  const one = activityCreateSchema.safeParse(body);
  if (!one.success) return NextResponse.json({ error: "Invalid activity line", issues: one.error.issues }, { status: 400 });
  if (!counterparties.get(one.data.counterpartyId)) return NextResponse.json({ error: "Counterparty not found" }, { status: 404 });
  return NextResponse.json({ activity: repo.create(one.data) }, { status: 201 });
}
