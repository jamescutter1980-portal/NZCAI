import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { InitiativeRepository, initiativeUpdateSchema } from "@/lib/value-chain";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = initiativeUpdateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid initiative", issues: parsed.error.issues }, { status: 400 });
  const repo = new InitiativeRepository(getDb());
  if (!repo.get(id)) return NextResponse.json({ error: "Initiative not found" }, { status: 404 });
  return NextResponse.json({ initiative: repo.update(id, parsed.data) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repo = new InitiativeRepository(getDb());
  if (!repo.get(id)) return NextResponse.json({ error: "Initiative not found" }, { status: 404 });
  repo.delete(id);
  return new NextResponse(null, { status: 204 });
}
