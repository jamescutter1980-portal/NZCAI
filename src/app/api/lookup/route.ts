import { NextResponse } from "next/server";
import { z } from "zod";
import { runScreening, formatPostcode } from "@/lib/assets";
import { runSourceOperation } from "@/lib/integrations/service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z
  .object({
    postcode: z.preprocess((v) => (v === "" || v === null ? undefined : String(v).toUpperCase().replace(/\s+/g, "")), z.string().regex(/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/, "not a UK postcode").optional()),
    latitude: z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : Number(v)), z.number().min(-90).max(90).optional()),
    longitude: z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : Number(v)), z.number().min(-180).max(180).optional()),
    uprn: z.preprocess((v) => (v === "" || v === null ? undefined : String(v)), z.string().regex(/^\d{1,12}$/).optional()),
  })
  .refine((v) => v.postcode || (v.latitude !== undefined && v.longitude !== undefined), "Give a postcode or a latitude and longitude");

/**
 * Ad-hoc location screening without creating an asset: the same profile the
 * asset page runs, on a postcode or a point. Nothing is stored.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid lookup", issues: parsed.error.issues }, { status: 400 });
  const q = parsed.data;
  let latitude = q.latitude;
  let longitude = q.longitude;
  let geocodeNote: string | undefined;
  if ((latitude === undefined || longitude === undefined) && q.postcode) {
    try {
      const r = await runSourceOperation("postcodes-io", "lookup", { postcode: formatPostcode(q.postcode) });
      const row = r.rows?.[0] as { latitude?: number; longitude?: number } | undefined;
      if (row?.latitude !== undefined && row?.longitude !== undefined) {
        latitude = row.latitude;
        longitude = row.longitude;
        geocodeNote = "Coordinates are the postcode centroid, not a building footprint.";
      } else geocodeNote = `Postcode not found by postcodes.io: ${r.summary}`;
    } catch (e) {
      geocodeNote = `Could not geocode the postcode (${e instanceof Error ? e.message : String(e)}); location checks skipped.`;
    }
  }
  const now = new Date().toISOString();
  const screening = await runScreening({ id: "adhoc", name: q.postcode ?? `${latitude},${longitude}`, postcode: q.postcode, latitude, longitude, uprn: q.uprn, createdAt: now, updatedAt: now });
  return NextResponse.json({ location: { postcode: q.postcode ? formatPostcode(q.postcode) : undefined, latitude, longitude, uprn: q.uprn, note: geocodeNote }, screening });
}
