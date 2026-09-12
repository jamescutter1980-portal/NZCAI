/**
 * Site Intelligence reference data and contract checks.
 *
 *   npm run site:verify              probe planning.data, report readiness
 *   npm run site:load-uprn <file>    load OS Open UPRN (or ONSUD) CSV
 *   npm run site:postcodes           derive postcode centroids from loaded UPRNs
 *   npm run site:load-ccod <file>    load HMLR CCOD or OCOD ownership CSV
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
import { ruleDatasets, unapprovedRules } from "@/lib/site-intel/rules";
import { loadMeesRules, unapprovedMeesRules } from "@/lib/site-intel/mees";
import { buildingCount, epcCounts, referenceDataCounts, titleCounts, voaCounts } from "@/lib/site-intel/stores";
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

/**
 * Loads CCOD (UK companies) or OCOD (overseas companies). The dataset is
 * detected from the header: OCOD carries a country-of-incorporation column.
 *
 * Both hold up to four proprietors in repeated column groups; those are folded
 * into one JSON array per title so a title is one row.
 */
async function loadOwnershipCsv(path: string, limit: number): Promise<void> {
  const stream = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

  let header: string[] | null = null;
  let dataset: "ccod" | "ocod" = "ccod";
  let idx: Record<string, number> = {};
  let proprietorGroups: { name: number; number: number; category: number; address: number; country: number }[] = [];
  let read = 0, written = 0, skipped = 0;

  const cell = (cells: string[], i: number): string | null =>
    i === -1 ? null : (cells[i] ?? "").trim() || null;

  for await (const line of stream) {
    if (!line.trim()) continue;
    const cells = splitCsv(line);

    if (!header) {
      header = cells;
      idx = {
        title: columnIndex(header, ["Title Number", "TitleNumber"]),
        tenure: columnIndex(header, ["Tenure"]),
        address: columnIndex(header, ["Property Address", "PropertyAddress"]),
        postcode: columnIndex(header, ["Postcode"]),
        district: columnIndex(header, ["District"]),
        county: columnIndex(header, ["County"]),
        region: columnIndex(header, ["Region"]),
        multiple: columnIndex(header, ["Multiple Address Indicator", "MultipleAddressIndicator"]),
        price: columnIndex(header, ["Price Paid", "PricePaid"]),
        added: columnIndex(header, ["Date Proprietor Added", "DateProprietorAdded"]),
      };
      if (idx.title === -1) {
        throw new Error(`No "Title Number" column in ${path}. Header: ${header.slice(0, 8).join(",")}`);
      }

      // Proprietor groups are numbered (1)..(4) in the HMLR headers.
      proprietorGroups = [1, 2, 3, 4].map((n) => ({
        name: columnIndex(header as string[], [`Proprietor Name (${n})`]),
        number: columnIndex(header as string[], [`Company Registration No. (${n})`]),
        category: columnIndex(header as string[], [`Proprietorship Category (${n})`]),
        address: columnIndex(header as string[], [`Proprietor (${n}) Address (1)`, `Proprietor Address (${n})`]),
        country: columnIndex(header as string[], [`Country Incorporated (${n})`]),
      }));

      dataset = proprietorGroups.some((g) => g.country !== -1) ? "ocod" : "ccod";
      console.log(`${DIM}detected ${dataset.toUpperCase()}, ${proprietorGroups.filter(g => g.name !== -1).length} proprietor slots${OFF}`);
      continue;
    }

    read += 1;
    if (read > limit) break;

    const titleNumber = cell(cells, idx.title);
    if (!titleNumber) { skipped += 1; continue; }

    const proprietors = proprietorGroups
      .map((g) => ({
        name: cell(cells, g.name),
        companyNumber: cell(cells, g.number),
        category: cell(cells, g.category),
        address: cell(cells, g.address),
        countryIncorporated: cell(cells, g.country),
      }))
      .filter((pr) => pr.name !== null);

    const priceRaw = cell(cells, idx.price);
    const price = priceRaw ? Number(priceRaw.replace(/[^0-9.]/g, "")) : null;

    await getPool().query(
      `INSERT INTO corporate_title
         (title_number, dataset, tenure, property_address, postcode, district,
          county, region, multiple_address, price_paid, proprietors,
          date_proprietor_added)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       ON CONFLICT (title_number) DO UPDATE SET
         dataset = EXCLUDED.dataset, tenure = EXCLUDED.tenure,
         property_address = EXCLUDED.property_address, postcode = EXCLUDED.postcode,
         district = EXCLUDED.district, county = EXCLUDED.county,
         region = EXCLUDED.region, multiple_address = EXCLUDED.multiple_address,
         price_paid = EXCLUDED.price_paid, proprietors = EXCLUDED.proprietors,
         date_proprietor_added = EXCLUDED.date_proprietor_added,
         loaded_at = now()`,
      [
        titleNumber.toUpperCase(),
        dataset,
        cell(cells, idx.tenure),
        cell(cells, idx.address),
        normalisePostcode(cell(cells, idx.postcode) ?? ""),
        cell(cells, idx.district),
        cell(cells, idx.county),
        cell(cells, idx.region),
        (cell(cells, idx.multiple) ?? "N").toUpperCase().startsWith("Y"),
        Number.isFinite(price as number) ? price : null,
        JSON.stringify(proprietors),
        cell(cells, idx.added),
      ],
    );
    written += 1;
  }

  console.log(`${GREEN}OK${OFF} ${dataset.toUpperCase()}: read ${read}, wrote ${written}, skipped ${skipped}`);
}

async function verify(): Promise<void> {
  console.log("Site Intelligence readiness\n");

  const counts = await referenceDataCounts();
  const mark = (n: number) => (n > 0 ? `${GREEN}${n}${OFF}` : `${RED}0${OFF}`);
  const titles = await titleCounts();
  console.log(`  os_uprn            ${mark(counts.uprns)} rows`);
  console.log(`  postcode_centroid  ${mark(counts.postcodes)} rows`);
  console.log(`  site_profile       ${counts.profiles} rows`);
  console.log(`  corporate_title    ${mark(titles.ccod + titles.ocod)} rows ${DIM}(CCOD ${titles.ccod}, OCOD ${titles.ocod})${OFF}`);
  if (titles.ccod + titles.ocod === 0) {
    console.log(`  ${YELLOW}-> load ownership: npm run site:load-ccod <file.csv>${OFF}`);
  }

  const buildings = await buildingCount();
  console.log(`  os_building        ${mark(buildings)} polygons`);
  if (buildings === 0) {
    console.log(`  ${YELLOW}-> no footprints, so every profile reports footprint: unavailable${OFF}`);
    console.log(`  ${YELLOW}   and S-02 has no geometry to screen. Load OS OpenMap Local:${OFF}`);
    console.log(`  ${DIM}   ogr2ogr -t_srs EPSG:4326 buildings.geojson Building.shp${OFF}`);
    console.log(`  ${DIM}   npm run site:load-buildings -- buildings.geojson${OFF}`);
  } else {
    console.log(`  ${DIM}Footprint lookup is exact and needs no PostGIS: bbox filter in SQL,${OFF}`);
    console.log(`  ${DIM}ray cast and edge test in geo.ts. Coverage is what has been loaded.${OFF}`);
  }

  const voa = await voaCounts();
  console.log(`  voa_assessment     ${mark(voa.assessments)} rows ${DIM}(${voa.surveyLines} survey lines)${OFF}`);
  if (voa.assessments === 0) {
    console.log(`  ${YELLOW}-> load VOA: npm run site:load-voa -- list <file.csv>${OFF}`);
  }
  if (counts.uprns === 0) {
    console.log(`  ${YELLOW}-> load OS Open UPRN: npm run site:load-uprn <file.csv>${OFF}`);
  }

  console.log("\nplanning.data.gov.uk slugs");
  // Brief 4.1: resolve slugs at startup and fail loudly on a missing one.
  const wanted = [DATASETS.title, DATASETS.lpa, DATASETS.lad, ...ruleDatasets()];
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

  console.log("\nconstraint wording");
  const unapproved = unapprovedRules();
  if (unapproved.length === 0) {
    console.log(`  ${GREEN}all ${ruleDatasets().length} rules approved${OFF}`);
  } else {
    console.log(`  ${YELLOW}${unapproved.length}/${ruleDatasets().length} awaiting James's sign-off${OFF}`);
    console.log(`  ${DIM}Set approved: true in constraint_rules.yaml once signed off.${OFF}`);
  }

  console.log("\nMEES wording and thresholds (S-05)");
  try {
    const mees = loadMeesRules();
    const unapprovedMees = unapprovedMeesRules();
    // +2 for the `meta` block and the `benchmark` block, which also need sign-off.
    const meesTotal = Object.keys({ ...mees.states, ...mees.flags }).length + 2;
    if (unapprovedMees.length === 0) {
      console.log(`  ${GREEN}all ${meesTotal} approved${OFF}`);
    } else {
      console.log(`  ${YELLOW}${unapprovedMees.length}/${meesTotal} awaiting James's sign-off${OFF}`);
      console.log(`  ${DIM}This wording concerns a legal duty. Set approved: true in${OFF}`);
      console.log(`  ${DIM}mees_rules.yaml only after reading it against the source.${OFF}`);
    }
    console.log(
      `  ${DIM}policy as at ${mees.meta.policy_as_at}: minimum ${mees.thresholds.minimum_band.band} ` +
      `(${mees.thresholds.minimum_band.status}), ${mees.thresholds.target_2031.band} by ` +
      `${mees.thresholds.target_2031.by} above ${mees.thresholds.target_2031.applies_above_m2} m² ` +
      `(${mees.thresholds.target_2031.status}), ${mees.thresholds.dropped_2027_c.was} EPC ` +
      `${mees.thresholds.dropped_2027_c.band} ${mees.thresholds.dropped_2027_c.status}${OFF}`,
    );
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

  const register = !!(process.env.EPC_API_KEY && process.env.EPC_API_EMAIL);
  console.log("\nresolution chain");
  console.log(`  ${register ? GREEN + "OK" : YELLOW + "ABSENT"}${OFF} address register (EPC)` +
    (register ? "" : ` ${DIM}- set EPC_API_EMAIL and EPC_API_KEY; without them no address reaches "exact"${OFF}`));
  const epc = await epcCounts();
  console.log(`  ${DIM}cached certificates: ${epc.certificates} (${epc.withUprn} with a UPRN)${OFF}`);
  console.log(`  ${DIM}check the endpoint with: npm run epc:verify -- <postcode>${OFF}`);
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
  if (command === "load-ccod") {
    if (!arg) throw new Error("Usage: site:load-ccod <path-to-csv>");
    await loadOwnershipCsv(arg, limit);
    return closePool();
  }
  if (command === "postcodes") {
    await derivePostcodeCentroids();
    return closePool();
  }
  throw new Error("Usage: tsx src/ingest/site.ts <verify|load-uprn|load-ccod|postcodes> [file]");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
