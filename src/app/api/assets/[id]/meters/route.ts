import { NextResponse } from "next/server";
import { z } from "zod";
import { AssetNotFoundError, AssetsRepository, assetMeterSchema } from "@/lib/assets";
import { getDb } from "@/lib/db/sqlite";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = assetMeterSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid meter", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json({ meter: new AssetsRepository(getDb()).linkMeter(id, parsed.data) }, { status: 201 });
  } catch (e) {
    if (e instanceof AssetNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}

const unlinkSchema = z.object({ mpxn: z.string(), utility: z.enum(["electricity", "gas"]), direction: z.enum(["import", "export"]).default("import") });

export async function DELETE(req: Request, { params }: Ctx) {
  const { id } = await params;
  const parsed = unlinkSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid query", issues: parsed.error.issues }, { status: 400 });
  const removed = new AssetsRepository(getDb()).unlinkMeter(id, parsed.data.mpxn, parsed.data.utility, parsed.data.direction);
  return NextResponse.json({ removed });
}
