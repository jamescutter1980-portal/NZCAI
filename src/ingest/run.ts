/**
 * Grid data CLI.
 *
 *   npm run grid:verify            probe every configured dataset
 *   npm run grid:verify -- ukpn    probe one DNO
 *   npm run grid:ingest            pull + load every verified-reachable dataset
 *   npm run grid:ingest -- npg     pull one DNO
 *
 * verify is the command to run first and after any registry edit. It resolves
 * each slug, prints the real field names, and suggests alternatives when a
 * slug 404s - so a wrong guess in the registry is a 20-second fix.
 */
import { closePool, getPool } from "@/lib/db";
import { DNOS, dnoById, supportedDnos, type DnoEntry, type DatasetRef } from "./registry";
import { describeDataset, exportAll, sampleRecords, searchDatasets } from "./opendatasoft";
import { normaliseEcr, normaliseSubstation } from "./normalise";
import { loadGridRules, unapprovedGridRules } from "@/lib/site-intel/grid-screen";

const GREEN = "\x1b[32m", RED = "\x1b[31m", DIM = "\x1b[2m", YELLOW = "\x1b[33m", OFF = "\x1b[0m";

function targets(arg: string | undefined): DnoEntry[] {
  if (!arg) return supportedDnos();
  const one = dnoById(arg);
  if (!one) {
    console.error(`Unknown DNO "${arg}". Known: ${DNOS.map((d) => d.id).join(", ")}`);
    process.exit(1);
  }
  if (!one.supported) {
    console.error(`${one.name} is not supported yet: ${one.note ?? ""}`);
    process.exit(1);
  }
  return [one];
}

async function verify(arg?: string): Promise<void> {
  let reachable = 0;
  let failed = 0;

  for (const dno of targets(arg)) {
    console.log(`\n${dno.name} ${DIM}(${dno.portalHost})${OFF}`);

    for (const ds of dno.datasets) {
      const tag = ds.verified ? "" : ` ${YELLOW}[unverified]${OFF}`;
      try {
        const meta = await describeDataset(dno.portalHost, ds.slug);
        const count = meta.records_count ?? "?";
        console.log(`  ${GREEN}OK${OFF}   ${ds.kind.padEnd(7)} ${ds.slug}${tag}  ${DIM}${count} records${OFF}`);

        const names = meta.fields.map((f) => f.name);
        console.log(`       ${DIM}fields: ${names.slice(0, 14).join(", ")}${names.length > 14 ? ` (+${names.length - 14})` : ""}${OFF}`);

        const [sample] = await sampleRecords(dno.portalHost, ds.slug, 1);
        if (sample) {
          const mapped = ds.kind === "heatmap"
            ? normaliseSubstation(sample, 0)
            : normaliseEcr(sample);
          if (!mapped) {
            console.log(`       ${YELLOW}warn: first record did not map - add aliases in normalise.ts${OFF}`);
          } else {
            console.log(`       ${DIM}mapped: ${JSON.stringify(mapped).slice(0, 150)}${OFF}`);
          }
        }
        reachable += 1;
      } catch (err) {
        failed += 1;
        console.log(`  ${RED}FAIL${OFF} ${ds.kind.padEnd(7)} ${ds.slug}${tag}`);
        console.log(`       ${DIM}${err instanceof Error ? err.message.slice(0, 160) : err}${OFF}`);
        try {
          const term = ds.kind === "heatmap" ? "heatmap" : "capacity";
          const found = await searchDatasets(dno.portalHost, term);
          if (found.length) {
            console.log(`       ${YELLOW}candidates: ${found.slice(0, 8).join(", ")}${OFF}`);
          }
        } catch {
          /* catalogue search is best-effort */
        }
      }
    }
  }

  console.log(`\n${reachable} reachable, ${failed} failed.`);
  if (failed > 0) {
    console.log("Fix the slugs in src/ingest/registry.ts, then re-run verify.");
  }

  /* -- S-03 boundaries and config, brief §5.1 and §5.4 -------------------- */

  console.log("\nDNO licence-area boundaries (brief §5.1)");
  try {
    const { rows } = await getPool().query<{ n: string; unmatched: string; version: string | null }>(
      `SELECT count(*)::text AS n,
              count(*) FILTER (WHERE dno_id IS NULL)::text AS unmatched,
              max(version_date)::text AS version
         FROM dno_licence_area`,
    );
    const n = Number(rows[0]?.n ?? 0);
    if (n === 0) {
      console.log(`  ${YELLOW}none loaded${OFF} — "which DNO" falls back to nothing at all.`);
      console.log(`  ${DIM}npm run grid:boundaries -- <NESO GeoJSON>${OFF}`);
    } else {
      console.log(`  ${GREEN}${n} area(s)${OFF} ${DIM}version ${rows[0].version ?? "not published"}${OFF}`);
      const unmatched = Number(rows[0].unmatched);
      if (unmatched > 0) {
        console.log(
          `  ${YELLOW}${unmatched} not mapped to a known DNO${OFF} ` +
          `${DIM}— a site in one returns no DNO rather than a wrong one${OFF}`,
        );
      }
    }
  } catch (err) {
    console.log(`  ${RED}FAIL${OFF} ${err instanceof Error ? err.message.slice(0, 140) : err}`);
  }

  console.log("\ngrid thresholds and wording (brief §5.4)");
  try {
    const rules = loadGridRules();
    const unapproved = unapprovedGridRules();
    if (unapproved.length === 0) {
      console.log(`  ${GREEN}all approved${OFF}`);
    } else {
      console.log(`  ${YELLOW}${unapproved.length} block(s) awaiting James's sign-off${OFF}: ${unapproved.join(", ")}`);
      console.log(`  ${DIM}Set approved: true in src/lib/site-intel/grid_rules.yaml.${OFF}`);
    }
    console.log(
      `  ${DIM}stale after ${rules.staleness.stale_after_days}d · ECR ${rules.ecr.radius_m / 1000} km ` +
      `at ${rules.ecr.min_export_kw} kW+ · nearest ${rules.proximity.nearest_count} within ` +
      `${rules.proximity.radius_m / 1000} km · RAG green ${rules.rag_bands.generation.green_mva} MVA${OFF}`,
    );
    if (!rules.connection_thresholds.verified) {
      console.log(
        `  ${YELLOW}G98/G99 values are null placeholders${OFF} ${DIM}— nothing reads them; ` +
        `replace from ENA Engineering Recommendation before anything does${OFF}`,
      );
    }
  } catch (err) {
    console.log(`  ${RED}FAIL${OFF} ${err instanceof Error ? err.message.slice(0, 140) : err}`);
  }

  await closePool();
}

async function ingestDataset(dno: DnoEntry, ds: DatasetRef): Promise<void> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO ingest_run (dno_id, dataset, kind) VALUES ($1,$2,$3) RETURNING id`,
    [dno.id, ds.slug, ds.kind],
  );
  const runId = rows[0].id;

  try {
    const records = await exportAll(dno.portalHost, ds.slug);
    let written = 0;

    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];

      if (ds.kind === "heatmap") {
        const row = normaliseSubstation(record, i);
        if (!row) continue;
        await getPool().query(
          `INSERT INTO substation
             (dno_id, source_ref, name, voltage_kv, voltage_group, lat, lng,
              demand_headroom_mva, generation_headroom_mva,
              demand_rag, generation_rag, constraint_note, source_dataset)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (dno_id, source_ref) DO UPDATE SET
             name = EXCLUDED.name,
             voltage_kv = EXCLUDED.voltage_kv,
             voltage_group = EXCLUDED.voltage_group,
             lat = EXCLUDED.lat,
             lng = EXCLUDED.lng,
             demand_headroom_mva = EXCLUDED.demand_headroom_mva,
             generation_headroom_mva = EXCLUDED.generation_headroom_mva,
             demand_rag = EXCLUDED.demand_rag,
             generation_rag = EXCLUDED.generation_rag,
             constraint_note = EXCLUDED.constraint_note,
             source_dataset = EXCLUDED.source_dataset,
             ingested_at = now()`,
          [
            dno.id, row.sourceRef, row.name, row.voltageKv, row.voltageGroup,
            row.latLng?.lat ?? null, row.latLng?.lng ?? null,
            row.demandHeadroomMva, row.generationHeadroomMva,
            row.demandRag, row.generationRag, row.constraintNote, ds.slug,
          ],
        );
      } else {
        const row = normaliseEcr(record);
        if (!row) continue;
        await getPool().query(
          `INSERT INTO ecr_record
             (dno_id, source_ref, site_name, connection_voltage_kv,
              import_capacity_mva, export_capacity_mva, energy_source,
              connection_status, substation_name, lat, lng, source_dataset)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            dno.id, row.sourceRef, row.siteName, row.connectionVoltageKv,
            row.importCapacityMva, row.exportCapacityMva, row.energySource,
            row.connectionStatus, row.substationName,
            row.latLng?.lat ?? null, row.latLng?.lng ?? null, ds.slug,
          ],
        );
      }
      written += 1;
    }

    await getPool().query(
      `UPDATE ingest_run SET finished_at = now(), rows_read = $2,
              rows_written = $3, status = 'ok' WHERE id = $1`,
      [runId, records.length, written],
    );
    console.log(`  ${GREEN}OK${OFF}   ${ds.kind.padEnd(7)} ${ds.slug}  ${written}/${records.length} rows`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await getPool().query(
      `UPDATE ingest_run SET finished_at = now(), status = 'failed', message = $2
       WHERE id = $1`,
      [runId, message.slice(0, 1000)],
    );
    console.log(`  ${RED}FAIL${OFF} ${ds.kind.padEnd(7)} ${ds.slug}`);
    console.log(`       ${DIM}${message.slice(0, 200)}${OFF}`);
  }
}

async function ingest(arg?: string): Promise<void> {
  // ECR is a full monthly republish, so replace rather than accumulate.
  await getPool().query("TRUNCATE ecr_record");

  for (const dno of targets(arg)) {
    console.log(`\n${dno.name}`);
    for (const ds of dno.datasets) {
      await ingestDataset(dno, ds);
    }
  }

  const [{ count }] = (
    await getPool().query<{ count: string }>("SELECT count(*)::text AS count FROM substation")
  ).rows;
  console.log(`\n${count} substations in database.`);
  await closePool();
}

const [, , command, arg] = process.argv;

if (command === "verify") {
  verify(arg).catch((err) => { console.error(err); process.exit(1); });
} else if (command === "ingest") {
  ingest(arg).catch((err) => { console.error(err); process.exit(1); });
} else {
  console.error("Usage: tsx src/ingest/run.ts <verify|ingest> [dnoId]");
  process.exit(1);
}
