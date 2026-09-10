import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import {
  ActivityLedgerRepository,
  CounterpartyNotFoundError,
  CounterpartyRepository,
  EmissionsReportRepository,
  EngagementRepository,
  counterpartyUpdateSchema,
} from "@/lib/value-chain";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** The dossier: the counterparty with every engagement, event, report and ledger line ever recorded against it. */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const db = getDb();
  const counterparty = new CounterpartyRepository(db).get(id);
  if (!counterparty) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const engagementRepo = new EngagementRepository(db);
  const engagements = engagementRepo.listForCounterparty(id).map((e) => ({ ...e, events: engagementRepo.events(e.id) }));
  return NextResponse.json({
    counterparty,
    engagements,
    reports: new EmissionsReportRepository(db).list({ counterpartyId: id }),
    activity: new ActivityLedgerRepository(db).list({ counterpartyId: id }),
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = counterpartyUpdateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid update", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json({ counterparty: new CounterpartyRepository(getDb()).update(id, parsed.data) });
  } catch (e) {
    if (e instanceof CounterpartyNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    new CounterpartyRepository(getDb()).delete(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof CounterpartyNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}
