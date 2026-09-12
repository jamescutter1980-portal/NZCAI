import { NextResponse } from "next/server";
import { loadProfile, ownershipFor, portfolioFor } from "@/lib/site-intel/service";
import { getProfile } from "@/lib/site-intel/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/site-intel/ownership
 *   ?uprn= | ?building_id=      ownership candidates for a site
 *   ?company=                   what a company owns
 *
 * `enrich=0` skips the Companies House lookups.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const company = params.get("company");
  const uprn = params.get("uprn") ?? undefined;
  const buildingId = params.get("building_id");
  const enrich = params.get("enrich") !== "0";

  try {
    if (company) {
      return NextResponse.json(await portfolioFor(company));
    }

    const profile = buildingId
      ? await loadProfile(buildingId)
      : (await getProfile({ uprn })).profile;

    if (!profile) {
      return NextResponse.json(
        { error: buildingId ? `No profile for building ${buildingId}` : "Could not resolve that site" },
        { status: 404 },
      );
    }

    const report = await ownershipFor(profile, { enrich });
    return NextResponse.json({ ...report, postcode: profile.postcode });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Ownership lookup failed" },
      { status: 500 },
    );
  }
}
