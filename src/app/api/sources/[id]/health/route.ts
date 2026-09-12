import { NextResponse } from "next/server";
import { runHealth, SourceNotFoundError } from "@/lib/integrations/service";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(await runHealth(id));
  } catch (e) {
    if (e instanceof SourceNotFoundError) return NextResponse.json({ error: "Unknown source" }, { status: 404 });
    return NextResponse.json({ ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
