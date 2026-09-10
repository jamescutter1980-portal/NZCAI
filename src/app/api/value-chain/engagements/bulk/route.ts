import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";
import { applyBulkAction, bulkEngagementActionSchema } from "@/lib/value-chain";

export const dynamic = "force-dynamic";

/** A wave: one action recorded against many counterparties. Disallowed transitions are skipped with the reason; the rest go through. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = bulkEngagementActionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid wave", issues: parsed.error.issues }, { status: 400 });
  const result = applyBulkAction(getDb(), parsed.data, defaultContext().now());
  return NextResponse.json({ applied: result.applied.length, skipped: result.skipped, engagements: result.applied });
}
