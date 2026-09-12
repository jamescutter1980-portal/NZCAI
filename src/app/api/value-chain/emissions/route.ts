import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { CounterpartyRepository, EmissionsReportRepository, emissionsReportCreateSchema } from "@/lib/value-chain";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const year = p.get("year");
  return NextResponse.json({
    reports: new EmissionsReportRepository(getDb()).list({ counterpartyId: p.get("counterpartyId") ?? undefined, reportingYear: year ? Number(year) : undefined }),
  });
}

/** Records the figures from a counterparty's annual GHG report, with the basis on which a share is attributed to us. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = emissionsReportCreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid report", issues: parsed.error.issues }, { status: 400 });
  const db = getDb();
  if (!new CounterpartyRepository(db).get(parsed.data.counterpartyId)) return NextResponse.json({ error: "Counterparty not found" }, { status: 404 });
  return NextResponse.json({ report: new EmissionsReportRepository(db).create(parsed.data) }, { status: 201 });
}
