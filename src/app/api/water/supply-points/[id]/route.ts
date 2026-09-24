import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { SupplyPointNotFoundError, supplyPointUpdateSchema, WaterRepository } from "@/lib/water";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supplyPoint = new WaterRepository(getDb()).getSupplyPoint(id);
  if (!supplyPoint) return NextResponse.json({ error: "Supply point not found" }, { status: 404 });
  return NextResponse.json({ supplyPoint });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = supplyPointUpdateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid update", issues: parsed.error.issues }, { status: 400 });
  try {
    const supplyPoint = new WaterRepository(getDb()).updateSupplyPoint(id, parsed.data);
    return NextResponse.json({ supplyPoint });
  } catch (e) {
    if (e instanceof SupplyPointNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    new WaterRepository(getDb()).deleteSupplyPoint(id);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    if (e instanceof SupplyPointNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
