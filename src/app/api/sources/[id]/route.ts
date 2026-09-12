import { NextResponse } from "next/server";
import { getIntegration } from "@/lib/integrations/registry";
import { describeIntegration } from "@/lib/integrations/service";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const def = getIntegration(id);
  if (!def) return NextResponse.json({ error: "Unknown source" }, { status: 404 });
  return NextResponse.json({ source: describeIntegration(def) });
}
