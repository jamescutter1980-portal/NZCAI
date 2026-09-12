import { NextResponse } from "next/server";
import { getProfile, loadProfile, voaFor } from "@/lib/site-intel/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/site-intel/voa?uprn= | ?building_id=
 *   &storeys=      adds the footprint x storeys estimate to the comparison
 *   &epc_area=     adds the EPC floor area to the comparison
 */
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const uprn = params.get("uprn") ?? undefined;
  const buildingId = params.get("building_id");

  const asNumber = (raw: string | null): number | undefined => {
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };

  try {
    const profile = buildingId
      ? await loadProfile(buildingId)
      : (await getProfile({ uprn })).profile;

    if (!profile) {
      return NextResponse.json(
        { error: buildingId ? `No profile for building ${buildingId}` : "Could not resolve that site" },
        { status: 404 },
      );
    }

    const report = await voaFor(profile, {
      storeys: asNumber(params.get("storeys")),
      epcFloorAreaM2: asNumber(params.get("epc_area")),
    });

    return NextResponse.json({ ...report, postcode: profile.postcode });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "VOA lookup failed" },
      { status: 500 },
    );
  }
}
