import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/sqlite";
import { CounterpartyRepository, counterpartyCreateSchema, type CounterpartyCreate } from "@/lib/value-chain";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const status = new URL(req.url).searchParams.get("status");
  const repo = new CounterpartyRepository(getDb());
  return NextResponse.json({ counterparties: repo.list(status === "active" || status === "inactive" ? { status } : {}) });
}

const batchSchema = z.object({ rows: z.array(z.unknown()).min(1).max(20_000) });

/** Accepts one counterparty, or a batch from a CSV import that upserts by name; a batch is all or nothing. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const repo = new CounterpartyRepository(getDb());
  const batch = batchSchema.safeParse(body);
  if (batch.success) {
    const prepared: CounterpartyCreate[] = [];
    const issues: { row: number; message: string }[] = [];
    batch.data.rows.forEach((raw, i) => {
      const parsed = counterpartyCreateSchema.safeParse(raw);
      if (!parsed.success) issues.push({ row: i + 1, message: parsed.error.issues.map((x) => `${x.path.join(".") || "row"}: ${x.message}`).join("; ") });
      else prepared.push(parsed.data);
    });
    if (issues.length > 0) {
      return NextResponse.json({ error: `${issues.length} of ${batch.data.rows.length} rows are invalid; nothing was imported.`, issues: issues.slice(0, 50) }, { status: 400 });
    }
    const result = repo.upsertBatch(prepared);
    return NextResponse.json({ created: result.created.length, updated: result.updated.length, counterparties: [...result.created, ...result.updated] }, { status: 201 });
  }
  const one = counterpartyCreateSchema.safeParse(body);
  if (!one.success) return NextResponse.json({ error: "Invalid counterparty", issues: one.error.issues }, { status: 400 });
  return NextResponse.json({ counterparty: repo.create(one.data) }, { status: 201 });
}
