import { NextResponse } from "next/server";
import { ConsentNotFoundError, consentUpdateSchema, getConsentStore, toView } from "@/lib/consent";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const record = await getConsentStore().get(id);
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ consent: toView(record) });
}

/** Updates status, expiry, evidence or notes. Withdrawal is a status change. */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = consentUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid update", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    const updated = await getConsentStore().update(id, parsed.data);
    return NextResponse.json({ consent: toView(updated) });
  } catch (e) {
    if (e instanceof ConsentNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
}
