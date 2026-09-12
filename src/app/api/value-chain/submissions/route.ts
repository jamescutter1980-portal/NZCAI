import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { SubmissionLinkRepository, ValueChainRecordNotFoundError, linkCreateSchema, type SubmissionState } from "@/lib/value-chain";

export const dynamic = "force-dynamic";

/** The links issued, without the tokens: those exist only in the response that created them. */
export function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const year = p.get("year");
  return NextResponse.json({
    links: new SubmissionLinkRepository(getDb()).list({
      counterpartyId: p.get("counterpartyId") ?? undefined,
      reportingYear: year ? Number(year) : undefined,
      state: (p.get("state") as SubmissionState | null) ?? undefined,
    }),
  });
}

/**
 * Issues a one-time link. The token comes back once and is not stored in
 * plain form, so it cannot be recovered later: send it or issue a new one.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = linkCreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid link request", issues: parsed.error.issues }, { status: 400 });
  try {
    const { link, token } = new SubmissionLinkRepository(getDb()).create(parsed.data);
    return NextResponse.json({ link, token, note: "This token is shown once and is not recoverable. Send the link now or issue a new one." }, { status: 201 });
  } catch (e) {
    if (e instanceof ValueChainRecordNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
