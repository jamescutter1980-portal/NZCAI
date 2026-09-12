import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { EmissionsReportRepository, ValueChainRecordNotFoundError, emissionsReportUpdateSchema } from "@/lib/value-chain";

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
  const parsed = emissionsReportUpdateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid update", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json({ report: new EmissionsReportRepository(getDb()).update(id, parsed.data) });
  } catch (e) {
    if (e instanceof ValueChainRecordNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    new EmissionsReportRepository(getDb()).delete(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ValueChainRecordNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}
