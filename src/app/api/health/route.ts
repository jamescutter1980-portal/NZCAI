import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const [counts] = await query<{ substations: string; ecr: string; samples: string }>(
      `SELECT (SELECT count(*) FROM substation)::text AS substations,
              (SELECT count(*) FROM ecr_record)::text AS ecr,
              (SELECT count(*) FROM substation
                WHERE source_dataset = 'fixture:sample')::text AS samples`,
    );

    const runs = await query<Record<string, unknown>>(
      `SELECT DISTINCT ON (dno_id, kind)
              dno_id, kind, dataset, status, started_at, finished_at,
              rows_written, message
         FROM ingest_run
        ORDER BY dno_id, kind, started_at DESC`,
    );

    return NextResponse.json({
      ok: true,
      substations: Number(counts.substations),
      ecrRecords: Number(counts.ecr),
      sampleRows: Number(counts.samples),
      lastRuns: runs,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unavailable" },
      { status: 503 },
    );
  }
}
