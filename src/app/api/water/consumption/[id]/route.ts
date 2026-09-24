import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { ConsumptionNotFoundError, consumptionUpdateSchema, WaterRepository } from "@/lib/water";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const reading = new WaterRepository(getDb()).getConsumption(id);
  if (!reading) return NextResponse.json({ error: "Consumption reading not found" }, { status: 404 });
  return NextResponse.json({ reading });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = consumptionUpdateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid update", issues: parsed.error.issues }, { status: 400 });
  try {
    const reading = new WaterRepository(getDb()).updateConsumption(id, parsed.data);
    return NextResponse.json({ reading });
  } catch (e) {
    if (e instanceof ConsumptionNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    new WaterRepository(getDb()).deleteConsumption(id);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    if (e instanceof ConsumptionNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
