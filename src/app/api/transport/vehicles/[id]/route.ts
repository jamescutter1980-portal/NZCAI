import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { TransportNotFoundError, TransportRepository, vehicleUpdateSchema } from "@/lib/transport";

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
  const parsed = vehicleUpdateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid update", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json({ vehicle: new TransportRepository(getDb()).updateVehicle(id, parsed.data) });
  } catch (e) {
    if (e instanceof TransportNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    new TransportRepository(getDb()).deleteVehicle(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof TransportNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}
