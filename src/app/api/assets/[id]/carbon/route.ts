import { NextResponse } from "next/server";
import { AssetsRepository } from "@/lib/assets";
import { assetCarbonForPeriod, gridRegionKey, intensityCoverage, periodFromSearchParams } from "@/lib/carbon";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const repo = new AssetsRepository(db);
  const asset = repo.get(id);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const p = periodFromSearchParams(req.url);
  if (!p.ok) return NextResponse.json({ error: p.error, issues: p.issues }, { status: 400 });
  const region = asset.postcode ? gridRegionKey(asset.postcode) : undefined;
  const carbon = assetCarbonForPeriod(db, defaultContext(), repo.meters(id), p.period, region);
  const totalKwh = carbon.energy.filter((e) => e.direction === "import").reduce((n, e) => n + e.kwh, 0);
  const eui = asset.floorAreaM2 ? Math.round((totalKwh / asset.floorAreaM2) * 10) / 10 : null;
  return NextResponse.json({
    carbon,
    eui: eui === null ? null : { kwhPerM2: eui, floorAreaM2: asset.floorAreaM2 },
    intensityCoverage: region ? intensityCoverage(db, region, p.period.factorYear) : null,
  });
}
