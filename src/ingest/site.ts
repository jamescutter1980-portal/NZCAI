/**
 * Site Intelligence reference data and contract checks.
 *
 *   npm run site:verify              probe planning.data, report readiness
 *   npm run site:load-uprn <file>    load OS Open UPRN (or ONSUD) CSV
 *   npm run site:postcodes           derive postcode centroids from loaded UPRNs
 *
 * OS Open UPRN is ~40M rows and is distributed as a zipped CSV from the OS
 * Downloads API, so loading takes a local file rather than fetching: download
 * OpenUPRN from https://osdatahub.os.uk, unzip, and point this at the CSV.
 *
 * Note OS Open UPRN carries UPRN and coordinates but NOT postcode. Postcode
 * linkage comes from the ONS UPRN Directory (ONSUD), which this loader also
 * accepts - run it twice, once per file, and the second pass fills postcodes in.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { closePool, getPool } from "@/lib/db";
import { checkSlugs } from "@/lib/site-intel/planning-data";
import { DATASETS } from "@/lib/site-intel/profile";
import { loadSources, unverifiedAttributions } from "@/lib/site-intel/sources";
import { referenceDataCounts } from "@/lib/site-intel/stores";
import { normalisePostcode } from "@/lib/site-intel/geo";

const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", OFF = "\x1b[0m";

/** Splits a CSV line, honouring double quotes. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(field); field = ""; }
    else field += ch;
  }
  out.push(field);
  return out;
}

function columnIndex(header: string[], candidates: string[]): number {
  const canon = header.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
  for (const candidate of candidates) {
    const idx = canon.indexOf(candidate.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (idx !== -1) return idx;
  }
  return -1;
}

async function loadUprnCsv(path: string, limit: number): Promise<void> {
  const stream = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

  let header: string[] | null = null;
  let iUprn = -1, iLat = -1, iLon = -1, iPostcode = -1;
  let read = 0, written = 0, skipped = 0;
  let batch: [string, number, number, string | null][] = [];

  const flush = async (): Promise<void> => {
    if (!batch.length) return;
    const values: unknown[] = [];
    const tuples = batch.map((row, i) => {
      values.push(row[0], row[1], row[2], row[3]);
      const b = i * 4;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4})`;
    });
    await getPool().query(
      `INSERT INTO os_uprn (uprn, lat, lng, postcode) VALUES ${tuples.join(",")}
       ON CONFLICT (uprn) DO UPDATE SET
         lat = COALESCE(EXCLUDED.lat, os_uprn.lat),
         lng = COALESCE(EXCLUDED.lng, os_uprn.lng),
         -- A second pass (ONSUD) fills postcodes without clearing coordinates.
         postcode = COALESCE(EXCLUDED.postcode, os_uprn.postcode),
         loaded_at = now()`,
      values,
    );
    written += batch.length;
    batch = [];
  };

  for await (const line of stream) {
    if (!line.trim()) continue;
    const cells = splitCsv(line);

    if (!header) {
      header = cells;
      iUprn = columnIndex(header, ["UPRN"]);
      iLat = columnIndex(header, ["LATITUDE", "LAT"]);
      iLon = columnIndex(header, ["LONGITUDE", "LONG", "LON"]);
      iPostcode = columnIndex(header, ["POSTCODE", "PCDS", "PCD", "POSTCODE_LOCATOR"]);
      if (iUprn === -1) throw new Error(`No UPRN column in ${path}. Header: ${header.join(",")}`);
      if (iLat === -1 && iPostcode === -1) {
        throw new Error(`${path} has neither coordinates nor postcode - nothing to load`);
      }
      console.log(
        `${DIM}columns: uprn=${iUprn} lat=${iLat} lon=${iLon} postcode=${iPostcode}${OFF}`,
      );
      continue;
    }

    read += 1;
    if (read > limit) break;

    const uprn = cells[iUprn]?.trim();
    if (!uprn) { skipped += 1; continue; }

    const lat = iLat === -1 ? NaN : Number(cells[iLat]);
    const lon = iLon === -1 ? NaN : Number(cells[iLon]);
    const postcode = iPostcode === -1 ? null : normalisePostcode(cells[iPostcode] ?? "");

    // Coordinates are mandatory on a first insert; a postcode-only row can only
    // update an existing UPRN, so skip it when we have neither.
    if (!Number.isFinite(lat) && !postcode) { skipped += 1; continue; }
    if (!Number.isFinite(lat)) {
      // Postcode-only pass: update in place, never insert a row without coords.
      await getPool().query(
        "UPDATE os_uprn SET postcode = $2, loaded_at = now() WHERE uprn = $1",
        [uprn, postcode],
      );
      written += 1;
      continue;
    }

    batch.push([uprn, lat, lon, postcode]);
    if (batch.length >= 1000) await flush();
  }

  await flush();
  console.log(`${GREEN}OK${OFF} read ${read}, wrote ${written}, skipped ${skipped}`);
}

/**
 * Postcode centroids derived from loaded UPRNs rather than Code-Point Open.
 *
 * Code-Point Open publishes eastings/northings on OSGB36, which would need a
 * full Helmert transform to reach WGS84. Averaging the UPRN points already in
 * the database avoids that dependency, uses authoritative OS coordinates, and
 * arguably centres better on actual buildings. Recorded as a deviation from the
 * brief in docs/site-intel/PLAN.md.
 */
async function derivePostcodeCentroids(): Promise<void> {
  const { rowCount } = await getPool().query(
    `INSERT INTO postcode_centroid (postcode, lat, lng)
     SELECT postcode, avg(lat), avg(lng)
       FROM os_uprn
      WHERE postcode IS NOT NULL
      GROUP BY postcode
     ON CONFLICT (postcode) DO UPDATE SET
       lat = EXCLUDED.lat, lng = EXCLUDED.lng, loaded_at = now()`,
  );
  console.log(`${GREEN}OK${OFF} derived ${rowCount ?? 0} postcode centroids from os_uprn`);
}

async function verify(): Promise<void> {
  console.log("Site Intelligence readiness\n");

  const counts = await referenceDataCounts();
  const mark = (n: number) => (n > 0 ? `${GREEN}${n}${OFF}` : `${RED}0${OFF}`);
  console.log(`  os_uprn            ${mark(counts.uprns)} rows`);
  console.log(`  postcode_centroid  ${mark(counts.postcodes)} rows`);
  console.log(`  site_profile       ${counts.profiles} rows`);
  if (counts.uprns === 0) {
    console.log(`  ${YELLOW}-> load OS Open UPRN: npm run site:load-uprn <file.csv>${OFF}`);
  }

  console.log("\nplanning.data.gov.uk slugs");
  const wanted = [DATASETS.title, DATASETS.lpa, DATASETS.lad];
  try {
    const { present, missing } = await checkSlugs(wanted);
    for (const slug of present) console.log(`  ${GREEN}OK${OFF}   ${slug}`);
    for (const slug of missing) console.log(`  ${RED}MISSING${OFF} ${slug}`);
    if (missing.length) {
      console.log(`  ${RED}Fix these in src/lib/site-intel/profile.ts DATASETS before relying on S-02.${OFF}`);
    }
  } catch (err) {
    console.log(`  ${RED}FAIL${OFF} ${err instanceof Error ? err.message.slice(0, 160) : err}`);
  }

  console.log("\nattribution strings");
  const unverified = unverifiedAttributions();
  const total = Object.keys(loadSources()).length;
  if (unverified.length === 0) {
    console.log(`  ${GREEN}all ${total} verified${OFF}`);
  } else {
    console.log(`  ${YELLOW}${unverified.length}/${total} unverified${OFF}: ${unverified.join(", ")}`);
    console.log(`  ${DIM}Open each licence_url in sources.yaml, confirm the wording, set${OFF}`);
    console.log(`  ${DIM}attribution_verified: true. Licence conditions, not decoration.${OFF}`);
  }

  const register = !!process.env.EPC_API_KEY;
  console.log("\nresolution chain");
  console.log(`  ${register ? GREEN + "OK" : YELLOW + "ABSENT"}${OFF} address register (EPC)` +
    (register ? "" : ` ${DIM}- no exact matches possible; addresses resolve at "probable" (Task 0)${OFF}`));
  console.log(`  ${process.env.GOOGLE_MAPS_SERVER_KEY ? GREEN + "OK" : DIM + "absent"}${OFF} geocoder fallback`);

  await closePool();
}

const [, , command, arg] = process.argv;
const limit = Number(process.env.SITE_INGEST_LIMIT ?? Number.MAX_SAFE_INTEGER);

async function main(): Promise<void> {
  if (command === "verify") return verify();
  if (command === "load-uprn") {
    if (!arg) throw new Error("Usage: site:load-uprn <path-to-csv>");
    await loadUprnCsv(arg, limit);
    return closePool();
  }
  if (command === "postcodes") {
    await derivePostcodeCentroids();
    return closePool();
  }
  throw new Error("Usage: tsx src/ingest/site.ts <verify|load-uprn|postcodes> [file]");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
