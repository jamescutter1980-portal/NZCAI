import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";
import { InboundRequestNotFoundError, rollForward } from "@/lib/value-chain";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Creates next year's request from this one: same requester, template and fields, deadline a year on. */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    return NextResponse.json({ request: rollForward(getDb(), id, defaultContext().now()) }, { status: 201 });
  } catch (e) {
    if (e instanceof InboundRequestNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}
