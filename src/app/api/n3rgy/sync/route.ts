import { NextResponse } from "next/server";
import { z } from "zod";
import { getConsentStore } from "@/lib/consent";
import { getDb } from "@/lib/db/sqlite";
import { N3rgyClient, N3rgyConfigError } from "@/lib/integrations/n3rgy";
import { runN3rgySync, summariseRun } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z.object({
  mpxn: z.string().regex(/^\d{6,13}$/).optional(),
  includeExport: z.boolean().optional(),
  includeTariff: z.boolean().optional(),
  backfillDays: z.number().int().min(1).max(400).optional(),
});

/**
 * Runs a sync. For scheduled use (Vercel Cron, a server cron, or a Task
 * Scheduler job) set SYNC_TOKEN and send it as `Authorization: Bearer ...`
 * or `?token=`. Without SYNC_TOKEN the route is open, which is only
 * acceptable behind the basic-auth proxy or on a local machine.
 */
export async function POST(req: Request) {
  const expected = process.env.SYNC_TOKEN?.trim();
  if (expected) {
    const url = new URL(req.url);
    const header = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (header !== expected && url.searchParams.get("token") !== expected) {
      return NextResponse.json({ error: "Sync token missing or wrong" }, { status: 401 });
    }
  }
  let body: unknown = {};
  const text = await req.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
    }
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid options", issues: parsed.error.issues }, { status: 400 });

  try {
    const client = new N3rgyClient();
    const run = await runN3rgySync({ db: getDb(), store: getConsentStore(), client }, { trigger: "api", ...parsed.data });
    return NextResponse.json({ run, headline: summariseRun(run) });
  } catch (e) {
    if (e instanceof N3rgyConfigError) return NextResponse.json({ error: e.message }, { status: 503 });
    throw e;
  }
}

/** Vercel Cron sends GET; treat it the same as POST with no options. */
export async function GET(req: Request) {
  return POST(new Request(req.url, { method: "POST", headers: req.headers }));
}
