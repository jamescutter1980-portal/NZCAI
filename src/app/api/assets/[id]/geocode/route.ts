import { NextResponse } from "next/server";
import { AssetsRepository, formatPostcode } from "@/lib/assets";
import { getDb } from "@/lib/db/sqlite";
import { runSourceOperation } from "@/lib/integrations/service";

export const dynamic = "force-dynamic";

/** Fills latitude/longitude (and country, district) from the asset's postcode via postcodes.io. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repo = new AssetsRepository(getDb());
  const asset = repo.get(id);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!asset.postcode) return NextResponse.json({ error: "Asset has no postcode" }, { status: 400 });
  try {
    const r = await runSourceOperation("postcodes-io", "lookup", { postcode: formatPostcode(asset.postcode) });
    const row = r.rows?.[0] as { latitude?: number; longitude?: number; country?: string } | undefined;
    if (!row?.latitude || !row?.longitude) return NextResponse.json({ error: r.summary }, { status: 404 });
    const updated = repo.update(id, { latitude: row.latitude, longitude: row.longitude, country: asset.country ?? row.country });
    return NextResponse.json({ asset: updated, summary: r.summary, warning: "Postcode centroid, not the building footprint. Adjust coordinates if the site is large." });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
