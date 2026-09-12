import { NextResponse } from "next/server";
import { ConsentNotFoundError, getConsentStore, toView } from "@/lib/consent";
import { N3rgyApiError, N3rgyClient, N3rgyConfigError } from "@/lib/integrations/n3rgy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Checks whether n3rgy currently grants access for the consent's MPxN.
 * A 200 from the utilities listing means consent is effective and the record
 * is marked active. A 403 means n3rgy has no consent yet; the record stays
 * as it is (pending) or, if it was active, is flagged so someone can look.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const store = getConsentStore();
  const record = await store.get(id);
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let client: N3rgyClient;
  try {
    client = new N3rgyClient();
  } catch (e) {
    if (e instanceof N3rgyConfigError) return NextResponse.json({ error: e.message }, { status: 503 });
    throw e;
  }

  const now = new Date().toISOString();
  try {
    const listing = await client.listUtilities(record.mpxn);
    const entries = listing.entries.map((e) => e.toLowerCase());
    const missing = record.utilities.filter((u) => !entries.includes(u));
    const detail =
      missing.length === 0
        ? `n3rgy (${client.environment}) lists ${entries.join(", ")}`
        : `n3rgy (${client.environment}) lists ${entries.join(", ") || "nothing"}; consent claims ${missing.join(", ")} too`;
    const updated = await store.update(id, {
      lastVerifiedAt: now,
      lastVerificationResult: "granted",
      lastVerificationDetail: detail,
      ...(record.status === "pending" ? { status: "active" as const } : {}),
    });
    return NextResponse.json({ consent: toView(updated), result: "granted", detail, missingUtilities: missing });
  } catch (e) {
    if (e instanceof ConsentNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (e instanceof N3rgyApiError) {
      const refused = e.status === 403 || e.status === 404;
      const updated = await store.update(id, {
        lastVerifiedAt: now,
        lastVerificationResult: refused ? "refused" : "error",
        lastVerificationDetail: `HTTP ${e.status}: ${e.message}`,
      });
      return NextResponse.json(
        { consent: toView(updated), result: refused ? "refused" : "error", detail: e.message, upstreamStatus: e.status },
        { status: refused ? 200 : 502 },
      );
    }
    throw e;
  }
}
