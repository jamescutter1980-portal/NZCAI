import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/sqlite";
import { IntegrationHttpError, defaultContext } from "@/lib/integrations/framework";
import { NotConfiguredError } from "@/lib/integrations/service";
import { CounterpartyNotFoundError, CounterpartyRepository, resolveCounterparty, searchCandidates } from "@/lib/value-chain";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

/** Companies House candidates for the counterparty's name (or ?q=). Nothing is applied. */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const counterparty = new CounterpartyRepository(getDb()).get(id);
  if (!counterparty) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const q = new URL(req.url).searchParams.get("q")?.trim() || counterparty.name;
  try {
    return NextResponse.json({ query: q, candidates: await searchCandidates(q, defaultContext()) });
  } catch (e) {
    return upstream(e);
  }
}

const bodySchema = z.object({ companyNumber: z.string().min(1).max(20) });

/** Applies the chosen company: number, sector from SIC codes, and register warnings. */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json(await resolveCounterparty(getDb(), id, parsed.data.companyNumber, defaultContext()));
  } catch (e) {
    if (e instanceof CounterpartyNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return upstream(e);
  }
}

function upstream(e: unknown): NextResponse {
  if (e instanceof NotConfiguredError) return NextResponse.json({ error: `Companies House is not configured: set ${e.missing.join(", ")} in .env.local.`, missing: e.missing }, { status: 503 });
  if (e instanceof IntegrationHttpError) return NextResponse.json({ error: e.message, upstreamStatus: e.status }, { status: 502 });
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
