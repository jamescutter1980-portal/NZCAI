import { NextResponse } from "next/server";
import { periodFromSearchParams } from "@/lib/carbon";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";
import { transportCarbon } from "@/lib/transport";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const p = periodFromSearchParams(req.url);
  if (!p.ok) return NextResponse.json({ error: p.error, issues: p.issues }, { status: 400 });
  return NextResponse.json(transportCarbon(getDb(), defaultContext(), p.period));
}
