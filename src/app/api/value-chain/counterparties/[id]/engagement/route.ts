import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";
import { ASKS, CounterpartyRepository, EngagementRepository, TransitionError, draftRequest, engagementActionSchema, transition } from "@/lib/value-chain";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const draftQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ask: z.enum(ASKS).optional(),
  client: z.string().max(200).optional(),
});

/** A request the consultant can paste into an email: the minimum ask, what it must contain, and the ledger fallback. Nothing is sent. */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const parsed = draftQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid query", issues: parsed.error.issues }, { status: 400 });
  const counterparty = new CounterpartyRepository(getDb()).get(id);
  if (!counterparty) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const clientName = parsed.data.client ?? process.env.CLIENT_NAME?.trim() ?? undefined;
  return NextResponse.json({ draft: draftRequest(counterparty, parsed.data.year, { ask: parsed.data.ask, dueOn: parsed.data.dueOn, clientName }) });
}

/** Records an engagement action for a reporting year: the state moves and an audit event is written. */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = engagementActionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid action", issues: parsed.error.issues }, { status: 400 });
  const db = getDb();
  const counterparty = new CounterpartyRepository(db).get(id);
  if (!counterparty) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const now = defaultContext().now();
  const today = now.toISOString().slice(0, 10);
  const repo = new EngagementRepository(db);
  const current = repo.ensure(id, parsed.data.reportingYear, counterparty.ask, now);
  try {
    const next = transition(current, parsed.data, today);
    const result = repo.applyTransition(current, next, { action: parsed.data.action, at: parsed.data.on ?? today, channel: parsed.data.channel, detail: parsed.data.detail, actor: parsed.data.actor }, now);
    return NextResponse.json({ engagement: result.engagement, event: result.event, events: repo.events(current.id) });
  } catch (e) {
    if (e instanceof TransitionError) return NextResponse.json({ error: e.message, state: current.state }, { status: 409 });
    throw e;
  }
}
