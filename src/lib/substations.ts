import { query } from "@/lib/db";
import type { Substation } from "@/lib/types";

export interface SubstationFilters {
  minGenerationHeadroomMva?: number;
  minVoltageKv?: number;
  bbox?: [number, number, number, number];
  limit?: number;
}

export interface SubstationResult {
  substations: Substation[];
  containsSampleData: boolean;
}

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
  ingested_at: Date | string;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

/**
 * Shared by the API route and the server-rendered page, so the first paint and
 * subsequent filtering return identically shaped rows.
 */
export async function findSubstations(
  filters: SubstationFilters = {},
): Promise<SubstationResult> {
  const where: string[] = ["s.lat IS NOT NULL", "s.lng IS NOT NULL"];
  const values: unknown[] = [];

  if (filters.bbox) {
    const [west, south, east, north] = filters.bbox;
    values.push(south, north, west, east);
    where.push(
      `s.lat BETWEEN $${values.length - 3} AND $${values.length - 2}`,
      `s.lng BETWEEN $${values.length - 1} AND $${values.length}`,
    );
  }
  if (filters.minGenerationHeadroomMva !== undefined) {
    values.push(filters.minGenerationHeadroomMva);
    where.push(`s.generation_headroom_mva >= $${values.length}`);
  }
  if (filters.minVoltageKv !== undefined) {
    values.push(filters.minVoltageKv);
    where.push(`s.voltage_kv >= $${values.length}`);
  }

  values.push(Math.min(filters.limit ?? 1000, 5000));

  const rows = await query<Row & Record<string, unknown>>(
    `SELECT s.id, s.dno_id, d.name AS dno_name, s.source_ref, s.name,
            s.voltage_kv, s.voltage_group, s.lat, s.lng,
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

  return {
    substations: rows.map((r) => ({
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
      ingestedAt: new Date(r.ingested_at).toISOString(),
    })),
    containsSampleData: rows.some((r) => r.source_dataset === "fixture:sample"),
  };
}
