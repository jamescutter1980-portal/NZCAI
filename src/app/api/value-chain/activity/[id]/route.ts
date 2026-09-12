import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { ActivityLedgerRepository, ValueChainRecordNotFoundError } from "@/lib/value-chain";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    new ActivityLedgerRepository(getDb()).delete(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ValueChainRecordNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}
