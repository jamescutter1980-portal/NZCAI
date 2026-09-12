import { NextResponse } from "next/server";
import { gridProfile } from "@/lib/site-intel/grid";
import { getProfile, loadProfile } from "@/lib/site-intel/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/site-intel/grid?uprn= | ?building_id= | ?lat=&lng=
 *
 * Optional ?export_mva= and ?load_mva= supply the inputs the two screens need.
 * Without them the screens stay `unrated`, which the brief requires: an
 * unrated screen means not assessed, never "fine".
 */
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;

  /**
   * Capacities cannot be negative. COORDINATES CAN, and most of Great Britain
   * has a negative longitude - so these need separate validators. Sharing one
   * "non-negative number" helper turned every site west of Greenwich into NaN,
   * which the point-in-polygon then reported as "no DNO contains this point":
   * a confident wrong answer rather than an error.
   */
  const capacity = (key: string): number | null => {
    const raw = params.get(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  };

  const coordinate = (key: string, limit: number): number | null => {
    const raw = params.get(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && Math.abs(n) <= limit ? n : NaN;
  };

  const exportMva = capacity("export_mva");
  const loadMva = capacity("load_mva");
  if (Number.isNaN(exportMva) || Number.isNaN(loadMva)) {
    return NextResponse.json(
      { error: "export_mva and load_mva must be non-negative numbers in MVA" },
      { status: 400 },
    );
  }

  try {
    let lat = coordinate("lat", 90);
    let lng = coordinate("lng", 180);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return NextResponse.json(
        { error: "lat must be within ±90 and lng within ±180" },
        { status: 400 },
      );
    }

    if (lat === null || lng === null) {
      const buildingId = params.get("building_id");
      const uprn = params.get("uprn") ?? undefined;
      const profile = buildingId
        ? await loadProfile(buildingId)
        : (await getProfile({ uprn })).profile;

      if (!profile?.lat || !profile.lon) {
        return NextResponse.json(
          { error: "Could not resolve a location for that site" },
          { status: 404 },
        );
      }
      lat = profile.lat;
      lng = profile.lon;
    }

    const result = await gridProfile(lat, lng, {
      proposedExportMva: exportMva,
      addedLoadMva: loadMva,
    });
    return NextResponse.json({ ...result, lat, lng });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Grid lookup failed" },
      { status: 500 },
    );
  }
}
