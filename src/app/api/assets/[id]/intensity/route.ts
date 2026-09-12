import { NextResponse } from "next/server";
import { z } from "zod";
import { AssetsRepository } from "@/lib/assets";
import { syncGridIntensity } from "@/lib/carbon";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** Backfills half-hourly regional grid intensity for the asset's postcode. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const asset = new AssetsRepository(db).get(id);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!asset.postcode) return NextResponse.json({ error: "Asset has no postcode" }, { status: 400 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "from and to must be YYYY-MM-DD", issues: parsed.error.issues }, { status: 400 });
  if (parsed.data.to < parsed.data.from) return NextResponse.json({ error: "to must not be before from" }, { status: 400 });
  try {
    const r = await syncGridIntensity(db, defaultContext(), asset.postcode, parsed.data.from, parsed.data.to);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
