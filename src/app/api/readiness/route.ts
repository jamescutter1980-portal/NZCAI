import { NextResponse } from "next/server";
import { periodFromSearchParams } from "@/lib/carbon";
import { getConsentStore } from "@/lib/consent/registry";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";
import { assessReadiness } from "@/lib/readiness";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Reporting readiness for a period: what is still missing before the return
 * can be filed. Takes the same period parameters as /api/portfolio.
 *
 * Missing reference data is an answer, not a failure: every check that cannot
 * run reports "unknown" with its reason inside a 200 response, so the page can
 * show a consultant what to fix rather than an error.
 */
export async function GET(req: Request) {
  const p = periodFromSearchParams(req.url);
  if (!p.ok) return NextResponse.json({ error: p.error, issues: p.issues }, { status: 400 });
  const report = await assessReadiness(getDb(), defaultContext(), p.period, { consentStore: getConsentStore() });
  return NextResponse.json(report);
}
