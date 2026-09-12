import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { ReadingsRepository } from "@/lib/db/readings-repo";
import { listSyncRuns } from "@/lib/sync";

export const dynamic = "force-dynamic";

/** Meters with stored readings plus recent sync runs. */
export async function GET() {
  const db = getDb();
  return NextResponse.json({ meters: new ReadingsRepository(db).listMeters(), runs: listSyncRuns(db, 10) });
}
