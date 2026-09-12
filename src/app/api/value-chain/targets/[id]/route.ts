import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { TargetRepository, targetCreateSchema } from "@/lib/value-chain";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = targetCreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid target", issues: parsed.error.issues }, { status: 400 });
  const repo = new TargetRepository(getDb());
  if (!repo.get(id)) return NextResponse.json({ error: "Target not found" }, { status: 404 });
  return NextResponse.json({ target: repo.update(id, parsed.data) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repo = new TargetRepository(getDb());
  if (!repo.get(id)) return NextResponse.json({ error: "Target not found" }, { status: 404 });
  repo.delete(id);
  return new NextResponse(null, { status: 204 });
}
