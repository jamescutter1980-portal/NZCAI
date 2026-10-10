import { NextResponse } from "next/server";
import { AssetsRepository, assetCreateSchema } from "@/lib/assets";
import { getDb } from "@/lib/db/sqlite";
import { assetView, clientScope, resolveAccess } from "@/lib/api-keys";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const db = getDb();
  const auth = resolveAccess(req, db);
  if (!auth.ok) return auth.response;
  const repo = new AssetsRepository(db);
  const assets = repo.list(clientScope(auth.access)).map((a) => ({ ...assetView(auth.access, a), meters: repo.meters(a.id).length, lastScreening: repo.listScreenings(a.id, 1)[0]?.ranAt ?? null }));
  return NextResponse.json({ assets });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = assetCreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid asset", issues: parsed.error.issues }, { status: 400 });
  const asset = new AssetsRepository(getDb()).create(parsed.data);
  return NextResponse.json({ asset }, { status: 201 });
}
