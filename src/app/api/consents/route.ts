import { NextResponse } from "next/server";
import { consentCreateSchema, getConsentStore, toView } from "@/lib/consent";

export const dynamic = "force-dynamic";

/** Lists consents, optionally filtered by ?mpxn=. */
export async function GET(req: Request) {
  const mpxn = new URL(req.url).searchParams.get("mpxn")?.replace(/\s+/g, "");
  const store = getConsentStore();
  const records = mpxn ? await store.findByMpxn(mpxn) : await store.list();
  return NextResponse.json({ consents: records.map((c) => toView(c)) });
}

/** Records a new consent. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = consentCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid consent", issues: parsed.error.issues }, { status: 400 });
  }
  if (parsed.data.expiresOn < parsed.data.grantedOn) {
    return NextResponse.json({ error: "expiresOn must not be before grantedOn" }, { status: 400 });
  }
  const created = await getConsentStore().create(parsed.data);
  return NextResponse.json({ consent: toView(created) }, { status: 201 });
}
