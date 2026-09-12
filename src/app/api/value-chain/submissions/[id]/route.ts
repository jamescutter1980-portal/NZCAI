import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { SubmissionLinkError, SubmissionLinkRepository, ValueChainRecordNotFoundError, acceptSubmission } from "@/lib/value-chain";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const link = new SubmissionLinkRepository(getDb()).get(id);
  return link ? NextResponse.json({ link }) : NextResponse.json({ error: "Submission link not found" }, { status: 404 });
}

/**
 * Accepts what a counterparty sent into the inventory, rejects it, or
 * withdraws an unused link. Accepting is the only path from a submission to a
 * reported figure, and it is deliberately on this side of the wall.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const action = (body as { action?: string })?.action;
  const repo = new SubmissionLinkRepository(getDb());
  if (!repo.get(id)) return NextResponse.json({ error: "Submission link not found" }, { status: 404 });
  try {
    if (action === "accept") {
      const { link, reportId } = acceptSubmission(getDb(), id);
      return NextResponse.json({ link, reportId });
    }
    if (action === "reject") return NextResponse.json({ link: repo.markRejected(id) });
    if (action === "revoke") return NextResponse.json({ link: repo.revoke(id) });
    return NextResponse.json({ error: "action must be accept, reject or revoke" }, { status: 400 });
  } catch (e) {
    if (e instanceof SubmissionLinkError) return NextResponse.json({ error: e.message, reason: e.reason }, { status: 409 });
    if (e instanceof ValueChainRecordNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repo = new SubmissionLinkRepository(getDb());
  if (!repo.get(id)) return NextResponse.json({ error: "Submission link not found" }, { status: 404 });
  repo.delete(id);
  return new NextResponse(null, { status: 204 });
}
