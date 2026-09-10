import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";
import { CounterpartyRepository, InboundRequestRepository, METRICS, inboundRequestCreateSchema, inboxSummary } from "@/lib/value-chain";

export const dynamic = "force-dynamic";

/** Every inbound data request with its deadline state, plus the metrics the portal can answer. */
export function GET() {
  const today = defaultContext().now().toISOString().slice(0, 10);
  return NextResponse.json({ ...inboxSummary(getDb(), today), metrics: METRICS });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = inboundRequestCreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  const db = getDb();
  if (!new CounterpartyRepository(db).get(parsed.data.counterpartyId)) return NextResponse.json({ error: "Requester not found: add the counterparty first" }, { status: 404 });
  return NextResponse.json({ request: new InboundRequestRepository(db).create(parsed.data, defaultContext().now()) }, { status: 201 });
}
