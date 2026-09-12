import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/sqlite";
import { SiteActivityRepository, siteActivityCreateSchema } from "@/lib/emissions";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  return NextResponse.json({
    activity: new SiteActivityRepository(getDb()).list({ from: p.get("from") ?? undefined, to: p.get("to") ?? undefined, assetId: p.get("assetId") ?? undefined }),
  });
}

const batchSchema = z.object({ rows: z.array(z.unknown()).min(1).max(20_000) });

/** Accepts one row or a batch from a CSV import; a batch is all or nothing. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const repo = new SiteActivityRepository(getDb());
  const batch = batchSchema.safeParse(body);
  if (batch.success) {
    const prepared: import("@/lib/emissions").SiteActivityCreate[] = [];
    const issues: { row: number; message: string }[] = [];
    batch.data.rows.forEach((raw, i) => {
      const parsed = siteActivityCreateSchema.safeParse(raw);
      if (!parsed.success) issues.push({ row: i + 1, message: parsed.error.issues.map((x) => `${x.path.join(".") || "row"}: ${x.message}`).join("; ") });
      else prepared.push(parsed.data);
    });
    if (issues.length > 0) {
      return NextResponse.json({ error: `${issues.length} of ${batch.data.rows.length} rows are invalid; nothing was imported.`, issues: issues.slice(0, 50) }, { status: 400 });
    }
    const created = repo.createBatch(prepared);
    return NextResponse.json({ created: created.length, activity: created }, { status: 201 });
  }
  const one = siteActivityCreateSchema.safeParse(body);
  if (!one.success) return NextResponse.json({ error: "Invalid activity", issues: one.error.issues }, { status: 400 });
  return NextResponse.json({ activity: repo.create(one.data) }, { status: 201 });
}
