import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/sqlite";
import { supplyPointCreateSchema, WaterRepository } from "@/lib/water";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  assetId: z.string().max(64).optional(),
  spid: z.string().max(20).optional(),
  retailerId: z.string().max(80).optional(),
});

export async function GET(req: Request) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid query", issues: parsed.error.issues }, { status: 400 });
  const repo = new WaterRepository(getDb());
  return NextResponse.json({ supplyPoints: repo.listSupplyPoints(parsed.data) });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = supplyPointCreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid supply point", issues: parsed.error.issues }, { status: 400 });
  const repo = new WaterRepository(getDb());
  const existing = repo.getSupplyPointBySpid(parsed.data.spid);
  if (existing) {
    return NextResponse.json({ error: `Supply point ${parsed.data.spid} already exists`, supplyPoint: existing }, { status: 409 });
  }
  const supplyPoint = repo.createSupplyPoint(parsed.data);
  return NextResponse.json({ supplyPoint }, { status: 201 });
}
