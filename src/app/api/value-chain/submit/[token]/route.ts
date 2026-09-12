import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { SubmissionLinkError, openInvitation, receiveSubmission, submissionPayloadSchema } from "@/lib/value-chain";

export const dynamic = "force-dynamic";

/**
 * The counterparty's side of the wall. The token in the path is the only
 * credential, so nothing here reveals anything about the client beyond what
 * the counterparty was already asked for, and no listing endpoint exists.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const { invitation } = openInvitation(getDb(), token, today());
    return NextResponse.json(invitation, { headers: NO_STORE });
  } catch (e) {
    return refuse(e);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }
  const parsed = submissionPayloadSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Some figures could not be read", issues: parsed.error.issues }, { status: 400, headers: NO_STORE });
  try {
    const link = receiveSubmission(getDb(), token, parsed.data);
    return NextResponse.json(
      { received: true, reportingYear: link.reportingYear, note: "Thank you. Your figures have been sent for review and will not be used until they are checked." },
      { status: 201, headers: NO_STORE },
    );
  } catch (e) {
    return refuse(e);
  }
}

const NO_STORE = { "cache-control": "no-store" };
const today = () => new Date().toISOString().slice(0, 10);

function refuse(e: unknown) {
  if (e instanceof SubmissionLinkError) {
    const status = e.reason === "not_found" ? 404 : 410;
    return NextResponse.json({ error: e.message, reason: e.reason }, { status, headers: NO_STORE });
  }
  throw e;
}
