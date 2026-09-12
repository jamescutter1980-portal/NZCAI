import { NextResponse } from "next/server";
import { describeQuery, isUnbounded, parseQuery } from "@/lib/site-intel/search";
import { runSearch } from "@/lib/site-intel/search-run";
import { describeRun } from "@/lib/site-intel/search-describe";

export const dynamic = "force-dynamic";

/**
 * GET /api/site-intel/search?q=...
 *
 * The query string is parsed into a structured filter and executed in SQL. No
 * site or client data goes to any model - see the header of search.ts.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const parsed = parseQuery(q);

  const body = {
    query: q,
    description: describeQuery(parsed),
    understood: parsed.understood,
    unparsed: parsed.unparsed,
  };

  if (parsed.empty) {
    return NextResponse.json({ ...body, results: [], applied: [], notApplied: [], caveats: [], total: 0 });
  }

  // An unbounded filter would return the whole rating list, which is never what
  // someone meant by a question.
  if (isUnbounded(parsed.filter)) {
    return NextResponse.json({
      ...body,
      results: [], applied: [], notApplied: [], caveats: [], total: 0,
      error: "That query has no filter in it, so it would return every building. Add a location, use or size.",
    });
  }

  try {
    const run = await runSearch(parsed.filter);
    // The description is the parse-layer summary; a clause can parse and still
    // not be executable, so the execution-layer omissions are folded in before
    // the string leaves the server.
    return NextResponse.json({
      ...body,
      ...run,
      description: describeRun(body.description, run.notApplied),
    });
  } catch (err) {
    return NextResponse.json(
      { ...body, error: err instanceof Error ? err.message : "Search failed" },
      { status: 500 },
    );
  }
}
