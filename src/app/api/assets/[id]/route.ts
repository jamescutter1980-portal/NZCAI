import { NextResponse } from "next/server";
import { AssetNotFoundError, AssetsRepository, assetUpdateSchema } from "@/lib/assets";
import { ReadingsRepository } from "@/lib/db/readings-repo";
import { getDb } from "@/lib/db/sqlite";
import { getConsentStore, toView } from "@/lib/consent";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const db = getDb();
  const repo = new AssetsRepository(db);
  const asset = repo.get(id);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const readings = new ReadingsRepository(db);
  const store = getConsentStore();
  const meters = await Promise.all(
    repo.meters(id).map(async (m) => {
      const key = { mpxn: m.mpxn, utility: m.utility, direction: m.direction };
      const consents = (await store.findByMpxn(m.mpxn)).map((c) => toView(c));
      const active = consents.find((c) => c.effectiveStatus === "active" && c.utilities.includes(m.utility));
      return { ...m, readings: readings.countReadings(key), latest: readings.latestIntervalStart(key) ?? null, consent: active ? { id: active.id, expiresOn: active.expiresOn } : null, consentStatus: active ? "active" : consents[0]?.effectiveStatus ?? "none" };
    }),
  );
  return NextResponse.json({ asset, meters, screenings: repo.listScreenings(id), latestScreening: repo.latestScreening(id) ?? null });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = assetUpdateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid update", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json({ asset: new AssetsRepository(getDb()).update(id, parsed.data) });
  } catch (e) {
    if (e instanceof AssetNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    new AssetsRepository(getDb()).delete(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AssetNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}
