import { NextResponse } from "next/server";
import { AssetsRepository, runScreening } from "@/lib/assets";
import { getDb } from "@/lib/db/sqlite";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repo = new AssetsRepository(getDb());
  const asset = repo.get(id);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const run = await runScreening(asset);
  repo.saveScreening(run);
  return NextResponse.json({ screening: run });
}
