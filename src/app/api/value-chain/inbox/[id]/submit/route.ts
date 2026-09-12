import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";
import { InboundRequestNotFoundError, SubmissionBlockedError, submitResponse } from "@/lib/value-chain";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Required when a figure disagrees with one already sent elsewhere: why they differ. */
  note: z.string().max(2000).optional(),
});

/** Snapshots the drafted figures as sent. Blocked with 409 while a figure disagrees with a previous submission and no note explains it. */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
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
  if (!parsed.success) return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json({ draft: submitResponse(getDb(), defaultContext(), id, parsed.data) });
  } catch (e) {
    if (e instanceof InboundRequestNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (e instanceof SubmissionBlockedError) return NextResponse.json({ error: e.message, conflicts: e.conflicts }, { status: 409 });
    throw e;
  }
}
