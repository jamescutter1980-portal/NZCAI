/**
 * Loads illustrative substation rows so the map renders before any live
 * ingest has run. These are NOT real DNO figures: coordinates are approximate
 * and every headroom value is invented. Rows are tagged `fixture:sample` and
 * the UI shows a banner whenever any are present.
 *
 * Replace with the real thing via `npm run grid:ingest`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closePool, getPool } from "@/lib/db";
import { DEMAND_BANDS, GENERATION_BANDS, ragFromHeadroom } from "@/lib/headroom";

interface Fixture {
  dnoId: string;
  sourceRef: string;
  name: string;
  voltageKv: number;
  voltageGroup: string;
  lat: number;
  lng: number;
  demandHeadroomMva: number | null;
  generationHeadroomMva: number | null;
  constraintNote: string | null;
}

async function main(): Promise<void> {
  const path = join(process.cwd(), "fixtures", "substations.sample.json");
  const rows = JSON.parse(readFileSync(path, "utf8")) as Fixture[];

  let written = 0;
  for (const row of rows) {
    await getPool().query(
      `INSERT INTO substation
         (dno_id, source_ref, name, voltage_kv, voltage_group, lat, lng,
          demand_headroom_mva, generation_headroom_mva,
          demand_rag, generation_rag, constraint_note, source_dataset)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'fixture:sample')
       ON CONFLICT (dno_id, source_ref) DO UPDATE SET
         name = EXCLUDED.name,
         lat = EXCLUDED.lat,
         lng = EXCLUDED.lng,
         demand_headroom_mva = EXCLUDED.demand_headroom_mva,
         generation_headroom_mva = EXCLUDED.generation_headroom_mva,
         demand_rag = EXCLUDED.demand_rag,
         generation_rag = EXCLUDED.generation_rag,
         source_dataset = 'fixture:sample',
         ingested_at = now()`,
      [
        row.dnoId,
        row.sourceRef,
        row.name,
        row.voltageKv,
        row.voltageGroup,
        row.lat,
        row.lng,
        row.demandHeadroomMva,
        row.generationHeadroomMva,
        ragFromHeadroom(row.demandHeadroomMva, DEMAND_BANDS),
        ragFromHeadroom(row.generationHeadroomMva, GENERATION_BANDS),
        row.constraintNote,
      ],
    );
    written += 1;
  }

  console.log(`seeded ${written} SAMPLE substations (tagged fixture:sample)`);
  console.log("Illustrative only - run `npm run grid:ingest` for real data.");
  await closePool();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
