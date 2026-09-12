import { NextResponse } from "next/server";
import { buildingCount, buildingsNear } from "@/lib/site-intel/stores";

export const dynamic = "force-dynamic";

/**
 * GET /api/site-intel/buildings?lat=&lng=&radius=
 *
 * Neighbouring OS OpenMap Local polygons, for map context and snap targets
 * while redrawing a footprint.
 *
 * Reports how many polygons are loaded in total as well as how many are
 * nearby: an empty result means "none within the radius" only if some are
 * loaded at all, and "nothing to snap to" for a different reason otherwise.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;

  const coordinate = (key: string, limit: number): number | null => {
    const raw = params.get(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && Math.abs(n) <= limit ? n : NaN;
  };

  const lat = coordinate("lat", 90);
  const lng = coordinate("lng", 180);
  if (lat === null || lng === null || Number.isNaN(lat) || Number.isNaN(lng)) {
    return NextResponse.json(
      { error: "lat (±90) and lng (±180) are required" },
      { status: 400 },
    );
  }

  const rawRadius = Number(params.get("radius") ?? 150);
  const radius = Number.isFinite(rawRadius) ? Math.min(Math.max(rawRadius, 10), 500) : 150;

  try {
    const [buildings, loaded] = await Promise.all([
      buildingsNear(lat, lng, radius),
      buildingCount(),
    ]);
    return NextResponse.json({ buildings, radiusM: radius, loadedTotal: loaded });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Building lookup failed" },
      { status: 500 },
    );
  }
}
