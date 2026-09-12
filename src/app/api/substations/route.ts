import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import type { Substation } from "@/lib/types";

export const dynamic = "force-dynamic";

interface Row {
  id: number;
  dno_id: string;
  dno_name: string;
  source_ref: string;
  name: string | null;
  voltage_kv: string | null;
  voltage_group: string | null;
  lat: number | null;
  lng: number | null;
  demand_headroom_mva: string | null;
  generation_headroom_mva: string | null;
  demand_rag: Substation["demandRag"];
  generation_rag: Substation["generationRag"];
  constraint_note: string | null;
  source_dataset: string;
  ingested_at: string;
}

function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function parseBbox(raw: string | null): [number, number, number, number] | null {
  if (!raw) return null;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts as [number, number, number, number];
}

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;

  const bbox = parseBbox(params.get("bbox"));
  const minGen = Number(params.get("minGenerationHeadroomMva"));
  const minVoltage = Number(params.get("minVoltageKv"));
  const dnoIds = params.get("dnoIds")?.split(",").filter(Boolean);
  const limit = Math.min(Number(params.get("limit")) || 1000, 5000);

  const where: string[] = ["s.lat IS NOT NULL", "s.lng IS NOT NULL"];
  const values: unknown[] = [];

  if (bbox) {
    // bbox arrives as west,south,east,north
    values.push(bbox[1], bbox[3], bbox[0], bbox[2]);
    where.push(
      `s.lat BETWEEN $${values.length - 3} AND $${values.length - 2}`,
      `s.lng BETWEEN $${values.length - 1} AND $${values.length}`,
    );
  }
  if (Number.isFinite(minGen) && params.get("minGenerationHeadroomMva")) {
    values.push(minGen);
    where.push(`s.generation_headroom_mva >= $${values.length}`);
  }
  if (Number.isFinite(minVoltage) && params.get("minVoltageKv")) {
    values.push(minVoltage);
    where.push(`s.voltage_kv >= $${values.length}`);
  }
  if (dnoIds?.length) {
    values.push(dnoIds);
    where.push(`s.dno_id = ANY($${values.length}::text[])`);
  }

  values.push(limit);

  try {
    const rows = await query<Row & Record<string, unknown>>(
      `SELECT s.id, s.dno_id, d.name AS dno_name, s.source_ref, s.name,
              s.voltage_kv, s.voltage_group,
              s.lat, s.lng,
              s.demand_headroom_mva, s.generation_headroom_mva,
              s.demand_rag, s.generation_rag, s.constraint_note,
              s.source_dataset, s.ingested_at
         FROM substation s
         JOIN dno d ON d.id = s.dno_id
        WHERE ${where.join(" AND ")}
        ORDER BY s.generation_headroom_mva DESC NULLS LAST
        LIMIT $${values.length}`,
      values,
    );

    const substations: Substation[] = rows.map((r) => ({
      id: r.id,
      dnoId: r.dno_id,
      dnoName: r.dno_name,
      sourceRef: r.source_ref,
      name: r.name,
      voltageKv: num(r.voltage_kv),
      voltageGroup: r.voltage_group,
      lat: r.lat,
      lng: r.lng,
      demandHeadroomMva: num(r.demand_headroom_mva),
      generationHeadroomMva: num(r.generation_headroom_mva),
      demandRag: r.demand_rag,
      generationRag: r.generation_rag,
      constraintNote: r.constraint_note,
      ingestedAt: r.ingested_at,
    }));

    const sampleCount = rows.filter((r) => r.source_dataset === "fixture:sample").length;

    return NextResponse.json({
      substations,
      count: substations.length,
      containsSampleData: sampleCount > 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Query failed";
    return NextResponse.json(
      { error: message, substations: [], count: 0, containsSampleData: false },
      { status: 500 },
    );
  }
}
