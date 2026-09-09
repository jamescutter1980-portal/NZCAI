import { NextResponse } from "next/server";
import { AssetsRepository } from "@/lib/assets";
import { assetCarbon, gridRegionKey, intensityCoverage } from "@/lib/carbon";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const repo = new AssetsRepository(db);
  const asset = repo.get(id);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const yearParam = new URL(req.url).searchParams.get("year");
  const year = yearParam ? Number(yearParam) : new Date().getUTCFullYear() - 1;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return NextResponse.json({ error: "year must be a four-digit year" }, { status: 400 });
  const region = asset.postcode ? gridRegionKey(asset.postcode) : undefined;
  const carbon = assetCarbon(db, defaultContext(), repo.meters(id), year, region);
  const totalKwh = carbon.energy.filter((e) => e.direction === "import").reduce((n, e) => n + e.kwh, 0);
  const eui = asset.floorAreaM2 ? Math.round((totalKwh / asset.floorAreaM2) * 10) / 10 : null;
  return NextResponse.json({ carbon, eui: eui === null ? null : { kwhPerM2: eui, floorAreaM2: asset.floorAreaM2 }, intensityCoverage: region ? intensityCoverage(db, region, year) : null });
}
