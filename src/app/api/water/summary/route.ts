import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/sqlite";
import { summarisePortfolio, WaterRepository } from "@/lib/water";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  assetId: z.string().max(64).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Portfolio roll-up of water consumption across supply points. */
export async function GET(req: Request) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid query", issues: parsed.error.issues }, { status: 400 });
  const repo = new WaterRepository(getDb());
  const supplyPoints = repo.listSupplyPoints({ assetId: parsed.data.assetId });
  const readings = repo.listConsumption({
    assetId: parsed.data.assetId,
    from: parsed.data.from,
    to: parsed.data.to,
  });
  return NextResponse.json({
    summary: summarisePortfolio(supplyPoints, readings, { from: parsed.data.from, to: parsed.data.to }),
  });
}
