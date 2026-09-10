import { NextResponse } from "next/server";
import { AssetsRepository } from "@/lib/assets";
import { assessAsset, type PathwayType, type Scenario } from "@/lib/assessment";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";

/**
 * CRREM alignment and UK NZCBS conformance for one asset and year.
 *
 * Missing reference data (no pathway file, no limit table, no matching
 * property type or sector) is never an error: it comes back as an
 * unassessable view with the reason, so the UI can say what to load.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const repo = new AssetsRepository(db);
  const asset = repo.get(id);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const q = new URL(req.url).searchParams;
  const yearParam = q.get("year");
  const year = yearParam ? Number(yearParam) : new Date().getUTCFullYear() - 1;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "year must be a four-digit year between 2000 and 2100" }, { status: 400 });
  }
  const scenarioParam = q.get("scenario") ?? undefined;
  if (scenarioParam && scenarioParam !== "1.5C" && scenarioParam !== "2C") {
    return NextResponse.json({ error: 'scenario must be "1.5C" or "2C"' }, { status: 400 });
  }
  const pathwayParam = q.get("pathwayType") ?? undefined;
  if (pathwayParam && pathwayParam !== "ghg" && pathwayParam !== "energy") {
    return NextResponse.json({ error: 'pathwayType must be "ghg" or "energy"' }, { status: 400 });
  }

  const { crrem, nzcbs } = assessAsset(db, defaultContext(), asset, repo.meters(id), {
    year,
    propertyType: q.get("propertyType") ?? undefined,
    sector: q.get("sector") ?? undefined,
    country: q.get("country") ?? undefined,
    scenario: scenarioParam as Scenario | undefined,
    pathwayType: pathwayParam as PathwayType | undefined,
    version: q.get("version") ?? undefined,
    nzcbsVersion: q.get("nzcbsVersion") ?? undefined,
  });
  return NextResponse.json({ crrem, nzcbs });
}
