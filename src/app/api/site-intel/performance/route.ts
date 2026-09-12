import { NextResponse } from "next/server";
import { getProfile, loadProfile, performanceFor } from "@/lib/site-intel/service";
import { unapprovedMeesRules } from "@/lib/site-intel/mees";

export const dynamic = "force-dynamic";

/**
 * GET /api/site-intel/performance?uprn= | ?building_id=
 *
 * Optional ?area_m2= and ?area_basis= supply a measured floor area for the
 * 1,000 m² MEES threshold test, which is a gross internal area of the demise.
 * The EPC's own floor area is used when none is given, and either way the
 * source travels with the result.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const uprn = params.get("uprn") ?? undefined;
  const buildingId = params.get("building_id");

  const rawArea = params.get("area_m2");
  const areaM2 = rawArea === null ? null : Number(rawArea);
  if (rawArea !== null && (!Number.isFinite(areaM2) || (areaM2 as number) <= 0)) {
    return NextResponse.json({ error: `"${rawArea}" is not a floor area in m²` }, { status: 400 });
  }

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

    const report = await performanceFor(profile, {
      area:
        areaM2 !== null
          ? { m2: areaM2, source: params.get("area_basis") ?? "supplied by the caller, basis not stated" }
          : undefined,
    });

    // The wording is law-adjacent and unapproved until James signs it off, so
    // that fact ships with every response rather than living only in a doc.
    return NextResponse.json({
      ...report,
      postcode: profile.postcode,
      wordingUnapproved: unapprovedMeesRules(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Performance screening failed" },
      { status: 500 },
    );
  }
}
