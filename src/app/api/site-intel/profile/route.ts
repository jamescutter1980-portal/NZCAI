import { NextResponse } from "next/server";
import {
  constraintsFor,
  getProfile,
  loadProfile,
  overrideProfile,
  resolveCandidates,
  saveProfile,
} from "@/lib/site-intel/service";
import { unapprovedRules } from "@/lib/site-intel/rules";
import { normalisePostcode } from "@/lib/site-intel/geo";
import { unverifiedAttributions } from "@/lib/site-intel/sources";

export const dynamic = "force-dynamic";

function num(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * GET /api/site-intel/profile
 *   ?address= | ?postcode= | ?uprn= | ?lat=&lon= | ?building_id=
 *
 * `candidates=1` returns the candidate list without building a full profile -
 * what the "Is this the building?" step needs.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;

  const buildingId = params.get("building_id");
  const address = params.get("address") ?? undefined;
  const rawPostcode = params.get("postcode");
  const uprn = params.get("uprn") ?? undefined;
  const lat = num(params.get("lat"));
  const lon = num(params.get("lon"));
  const candidatesOnly = params.get("candidates") === "1";
  const withConstraints = params.get("constraints") === "1";
  const allowGeocode = params.get("geocode") !== "0";

  try {
    if (buildingId) {
      const profile = await loadProfile(buildingId);
      if (!profile) {
        return NextResponse.json({ error: `No profile for building ${buildingId}` }, { status: 404 });
      }
      return NextResponse.json({
        profile,
        buildingId,
        constraints: withConstraints ? await constraintsFor(profile) : null,
      });
    }

    const postcode = rawPostcode ? normalisePostcode(rawPostcode) ?? undefined : undefined;
    if (rawPostcode && !postcode) {
      return NextResponse.json({ error: `"${rawPostcode}" is not a valid UK postcode` }, { status: 400 });
    }

    const point = lat !== undefined && lon !== undefined ? { lat, lon } : undefined;
    if (!address && !postcode && !uprn && !point) {
      return NextResponse.json(
        { error: "Provide address, postcode, uprn, or lat and lon" },
        { status: 400 },
      );
    }

    const input = { address, postcode, uprn, point };

    if (candidatesOnly) {
      const resolved = await resolveCandidates(input, { allowGeocode });
      return NextResponse.json({
        candidates: resolved.candidates,
        step: resolved.step,
        reason: resolved.reason ?? null,
      });
    }

    const result = await getProfile(input, { allowGeocode });
    return NextResponse.json({
      profile: result.profile,
      candidates: result.candidates,
      step: result.step,
      reason: result.reason ?? null,
      constraints:
        withConstraints && result.profile ? await constraintsFor(result.profile) : null,
      // Surfaced so nobody ships a report with an unchecked attribution string
      // or wording James has not signed off.
      unverifiedAttributions: unverifiedAttributions(),
      unapprovedWording: unapprovedRules(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Site intelligence failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** POST persists a confirmed profile against a building id. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      buildingId?: string;
      uprn?: string;
      address?: string;
      postcode?: string;
      lat?: number;
      lon?: number;
    };
    if (!body.buildingId) {
      return NextResponse.json({ error: "buildingId is required" }, { status: 400 });
    }

    const point = body.lat !== undefined && body.lon !== undefined
      ? { lat: body.lat, lon: body.lon }
      : undefined;

    const result = await getProfile({
      uprn: body.uprn,
      address: body.address,
      postcode: body.postcode,
      point,
    });

    if (!result.profile) {
      return NextResponse.json({ error: result.reason ?? "Could not resolve" }, { status: 404 });
    }

    await saveProfile(body.buildingId, result.profile);
    return NextResponse.json({ profile: result.profile, buildingId: body.buildingId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Save failed" },
      { status: 500 },
    );
  }
}

/** PATCH records a user override: confirmed pin, moved pin, or redrawn footprint. */
export async function PATCH(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      buildingId?: string;
      confirmed?: boolean;
      footprint?: GeoJSON.Geometry;
      lat?: number;
      lon?: number;
    };
    if (!body.buildingId) {
      return NextResponse.json({ error: "buildingId is required" }, { status: 400 });
    }

    const profile = await overrideProfile(body.buildingId, {
      confirmed: body.confirmed,
      footprint: body.footprint,
      point: body.lat !== undefined && body.lon !== undefined
        ? { lat: body.lat, lon: body.lon }
        : undefined,
    });

    return profile
      ? NextResponse.json({ profile, buildingId: body.buildingId })
      : NextResponse.json({ error: `No profile for building ${body.buildingId}` }, { status: 404 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Override failed" },
      { status: 500 },
    );
  }
}
