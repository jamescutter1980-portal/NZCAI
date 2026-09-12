import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { SiteActivityNotFoundError, SiteActivityRepository, siteActivityUpdateSchema } from "@/lib/emissions";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = siteActivityUpdateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid update", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json({ activity: new SiteActivityRepository(getDb()).update(id, parsed.data) });
  } catch (e) {
    if (e instanceof SiteActivityNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    new SiteActivityRepository(getDb()).delete(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof SiteActivityNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}
