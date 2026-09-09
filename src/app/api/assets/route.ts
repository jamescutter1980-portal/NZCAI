import { NextResponse } from "next/server";
import { AssetsRepository, assetCreateSchema } from "@/lib/assets";
import { getDb } from "@/lib/db/sqlite";

export const dynamic = "force-dynamic";

export async function GET() {
  const repo = new AssetsRepository(getDb());
  const assets = repo.list().map((a) => ({ ...a, meters: repo.meters(a.id).length, lastScreening: repo.listScreenings(a.id, 1)[0]?.ranAt ?? null }));
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
