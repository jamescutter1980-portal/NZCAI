/**
 * Bulk EPC loader.
 *
 *   npm run epc:load -- <certificates.csv>
 *
 * The register publishes bulk downloads at
 * https://get-energy-performance-data.communities.gov.uk/download — a zip per
 * local authority, each containing `certificates.csv` (and
 * `recommendations.csv`, which is not loaded here).
 *
 * WHY THIS EXISTS. Until now `epc_certificate` was filled one postcode at a
 * time by lookups, so the S-08 prospect list could only ever cover postcodes
 * somebody had already searched. That is a fine cache and a useless corpus. A
 * bulk load makes the coverage statement mean something.
 *
 * These are real CSV files - comma-delimited, quoted, with a header row - so
 * unlike the VOA asterisk files the columns are read by NAME, and a missing
 * column is reported rather than silently read as null.
 *
 * NOT VERIFIED AGAINST A REAL FILE. This build could not reach the download.
 * The column names follow the register's published schema; the loader prints
 * the header it found and the first parsed record so a mismatch is obvious on
 * the first run, and unknown columns are listed rather than ignored.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { closePool, getPool } from "@/lib/db";
import { normalisePostcode } from "@/lib/site-intel/geo";
import { toCertificate, type EpcRegister } from "@/lib/site-intel/epc";
import { parseCsvLine } from "./csv";

const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", OFF = "\x1b[0m";

/** Columns the screening needs. A file missing these is worth stopping for. */
const REQUIRED = ["lmk-key"];

/** Columns S-05 and S-08 read. Absent ones are reported, not fatal. */
const WANTED = [
  "lmk-key", "address", "address1", "address2", "address3", "postcode", "uprn",
  "uprn-source", "asset-rating", "asset-rating-band", "floor-area",
  "total-floor-area", "inspection-date", "lodgement-date", "property-type",
  "building-reference-number", "main-heating-fuel", "building-emissions",
  "target-emissions", "standard-emissions", "primary-energy-value",
  "transaction-type",
];

async function load(path: string, register: EpcRegister, limit: number): Promise<void> {
  const pool = getPool();
  const started = await pool.query(
    `INSERT INTO epc_bulk_load (source_file, register, note)
     VALUES ($1, $2, $3) RETURNING id`,
    [path, register, "columns read by name; see epc-load.ts header"],
  );
  const loadId = started.rows[0].id as number;

  const stream = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });

  let header: string[] | null = null;
  let read = 0, loaded = 0, skipped = 0, printed = false;

  for await (const line of stream) {
    if (!line.trim()) continue;

    if (!header) {
      header = parseCsvLine(line).map((h) => h.toLowerCase());
      console.log(`${DIM}header: ${header.length} columns${OFF}`);

      const missingRequired = REQUIRED.filter((c) => !header?.includes(c));
      if (missingRequired.length) {
        console.log(`${RED}FAIL${OFF} required column(s) missing: ${missingRequired.join(", ")}`);
        console.log(`${DIM}first columns seen: ${header.slice(0, 12).join(", ")}${OFF}`);
        break;
      }
      const missingWanted = WANTED.filter((c) => !header?.includes(c));
      if (missingWanted.length) {
        console.log(
          `${YELLOW}note${OFF} ${missingWanted.length} expected column(s) absent, ` +
          `so those values will be null: ${missingWanted.join(", ")}`,
        );
      }
      continue;
    }

    read++;
    if (read > limit) break;

    const cells = parseCsvLine(line);
    const row: Record<string, unknown> = {};
    header.forEach((name, i) => { row[name] = cells[i] ?? null; });

    const certificate = toCertificate(row, register);
    if (!certificate) { skipped++; continue; }

    // A certificate with no postcode cannot be placed, and every S-08 filter
    // and the coverage statement are postcode-based.
    const postcode = normalisePostcode(certificate.postcode ?? "");
    if (!postcode) { skipped++; continue; }

    if (!printed) {
      console.log(`${DIM}first record: ${JSON.stringify({
        lmkKey: certificate.lmkKey,
        address: certificate.address,
        postcode,
        rating: certificate.rating,
        assetRating: certificate.assetRating,
        floorAreaM2: certificate.floorAreaM2,
        mainFuel: certificate.mainFuel,
        lodgementDate: certificate.lodgementDate,
      })}${OFF}`);
      console.log(`${DIM}Check that against the file before trusting the load.${OFF}`);
      printed = true;
    }

    await pool.query(
      `INSERT INTO epc_certificate
         (lmk_key, register, address, postcode, uprn, uprn_source, rating,
          asset_rating, floor_area_m2, inspection_date, lodgement_date,
          property_type, building_reference, main_fuel, building_emissions,
          target_emissions, standard_emissions, primary_energy, transaction_type,
          retrieved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
       ON CONFLICT (lmk_key) DO UPDATE SET
         address = EXCLUDED.address, postcode = EXCLUDED.postcode,
         uprn = EXCLUDED.uprn, uprn_source = EXCLUDED.uprn_source,
         rating = EXCLUDED.rating, asset_rating = EXCLUDED.asset_rating,
         floor_area_m2 = EXCLUDED.floor_area_m2,
         inspection_date = EXCLUDED.inspection_date,
         lodgement_date = EXCLUDED.lodgement_date,
         property_type = EXCLUDED.property_type,
         building_reference = EXCLUDED.building_reference,
         main_fuel = EXCLUDED.main_fuel,
         building_emissions = EXCLUDED.building_emissions,
         target_emissions = EXCLUDED.target_emissions,
         standard_emissions = EXCLUDED.standard_emissions,
         primary_energy = EXCLUDED.primary_energy,
         transaction_type = EXCLUDED.transaction_type,
         retrieved_at = now()`,
      [
        certificate.lmkKey, register, certificate.address, postcode,
        certificate.uprn, certificate.uprnSource, certificate.rating,
        certificate.assetRating, certificate.floorAreaM2,
        certificate.inspectionDate, certificate.lodgementDate,
        certificate.propertyType, certificate.buildingReference,
        certificate.mainFuel, certificate.buildingEmissions,
        certificate.targetEmissions, certificate.standardEmissions,
        certificate.primaryEnergy, certificate.transactionType,
      ],
    );
    loaded++;
    if (loaded % 5000 === 0) console.log(`${DIM}  ${loaded.toLocaleString()} loaded${OFF}`);
  }

  await pool.query(
    `UPDATE epc_bulk_load
        SET rows_read = $2, rows_loaded = $3, rows_skipped = $4, finished_at = now()
      WHERE id = $1`,
    [loadId, read, loaded, skipped],
  );

  console.log(
    `${GREEN}loaded${OFF} ${loaded.toLocaleString()} of ${read.toLocaleString()} rows` +
    (skipped ? `, ${YELLOW}${skipped.toLocaleString()} skipped${OFF} (no key or no postcode)` : ""),
  );
  console.log(
    `${DIM}Coverage is now whatever has been loaded. The prospect list says so on every run.${OFF}`,
  );
}

const [, , path, registerArg] = process.argv;

async function main(): Promise<void> {
  if (!path) {
    console.log("usage: npm run epc:load -- <certificates.csv> [register]");
    console.log("  register defaults to non-domestic; domestic and display are accepted");
    process.exit(1);
  }
  const register = (registerArg ?? "non-domestic") as EpcRegister;
  if (!["domestic", "non-domestic", "display"].includes(register)) {
    console.log(`${RED}unknown register "${register}"${OFF}`);
    process.exit(1);
  }

  const limit = Number(process.env.EPC_LOAD_LIMIT ?? Number.MAX_SAFE_INTEGER);
  console.log(`Loading ${register} certificates from ${path}`);
  await load(path, register, limit);
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
