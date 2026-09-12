import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";
import { InboundRequestNotFoundError, InboundRequestRepository, draftResponse, inboundRequestUpdateSchema } from "@/lib/value-chain";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** The request with its drafted response: every field answered from the portal's figures, with source, overrides and consistency conflicts. */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const db = getDb();
  const request = new InboundRequestRepository(db).get(id);
  if (!request) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ draft: draftResponse(db, defaultContext(), request) });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = inboundRequestUpdateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid update", issues: parsed.error.issues }, { status: 400 });
  try {
    const db = getDb();
    const request = new InboundRequestRepository(db).update(id, parsed.data, defaultContext().now());
    return NextResponse.json({ request, draft: draftResponse(db, defaultContext(), request) });
  } catch (e) {
    if (e instanceof InboundRequestNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    new InboundRequestRepository(getDb()).delete(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof InboundRequestNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}
