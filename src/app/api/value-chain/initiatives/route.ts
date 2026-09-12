import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { CounterpartyRepository, InitiativeRepository, initiativeCreateSchema, type InitiativeStatus } from "@/lib/value-chain";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  return NextResponse.json({
    initiatives: new InitiativeRepository(getDb()).list({
      counterpartyId: p.get("counterpartyId") ?? undefined,
      status: (p.get("status") as InitiativeStatus | null) ?? undefined,
    }),
  });
}

/** Records an abatement initiative. Expected savings are a plan, never a deduction from measured emissions. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = initiativeCreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid initiative", issues: parsed.error.issues }, { status: 400 });
  const db = getDb();
  if (parsed.data.counterpartyId && !new CounterpartyRepository(db).get(parsed.data.counterpartyId)) {
    return NextResponse.json({ error: "Counterparty not found" }, { status: 404 });
  }
  return NextResponse.json({ initiative: new InitiativeRepository(db).create(parsed.data) }, { status: 201 });
}
