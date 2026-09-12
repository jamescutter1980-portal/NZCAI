import { NextResponse } from "next/server";
import { epcFor, getProfile, loadProfile } from "@/lib/site-intel/service";

export const dynamic = "force-dynamic";

/** GET /api/site-intel/epc?uprn= | ?building_id= */
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const uprn = params.get("uprn") ?? undefined;
  const buildingId = params.get("building_id");

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

    const report = await epcFor(profile);
    return NextResponse.json({ ...report, postcode: profile.postcode });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "EPC lookup failed" },
      { status: 500 },
    );
  }
}
