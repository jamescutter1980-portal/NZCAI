/**
 * VOA rating list loader.
 *
 *   npm run site:load-voa -- list <file>   compiled rating list (assessments)
 *   npm run site:load-voa -- smv <file>    summary valuations (survey lines)
 *
 * Download both from https://voaratinglists.blob.core.windows.net/html/rlidata.htm
 *
 * The files are ASTERISK-DELIMITED despite carrying a .csv extension, which is
 * the single most common way to get this import wrong.
 *
 * Field positions below follow the published VOA data specification but have
 * NOT been checked against a real file - this build could not reach the source.
 * Both loaders print the first parsed record so a mismatch is obvious on the
 * first run, and positions can be overridden with VOA_LIST_MAP / VOA_SMV_MAP as
 * JSON without touching code.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { closePool, getPool } from "@/lib/db";
import { normalisePostcode } from "@/lib/site-intel/geo";
import type { AreaBasis } from "@/lib/site-intel/voa";

const GREEN = "\x1b[32m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", OFF = "\x1b[0m";

/** Zero-based field positions in the compiled list record. */
const LIST_MAP = {
  billingAuthorityCode: 1,
  billingAuthorityReference: 3,
  scatCode: 4,
  primaryDescription: 5,
  uarn: 6,
  fullPropertyIdentifier: 7,
  number: 9,
  street: 10,
  town: 11,
  postalDistrict: 12,
  county: 13,
  postcode: 14,
  effectiveDate: 15,
  rateableValue: 17,
};

/** Zero-based field positions in the summary valuation survey lines. */
const SMV_MAP = {
  uarn: 1,
  lineDescription: 4,
  areaM2: 5,
  basis: 6,
  pricePerM2: 7,
  value: 8,
};

function mapFrom(envVar: string, fallback: Record<string, number>): Record<string, number> {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(raw) as Record<string, number>) };
  } catch {
    throw new Error(`${envVar} is not valid JSON`);
  }
}

const field = (cells: string[], i: number | undefined): string | null =>
  i === undefined || i < 0 ? null : (cells[i] ?? "").trim() || null;

function num(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/** VOA dates appear as DD-MMM-YYYY or YYYY-MM-DD depending on the file. */
function isoDate(value: string | null): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

function toBasis(value: string | null): AreaBasis {
  const text = (value ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  // Never default to GIA. An unstated basis stays unknown so a number is not
  // mistaken for a measurement standard it may not be on.
  const known: AreaBasis[] = ["GIA", "NIA", "GEA", "EFA"];
  return known.includes(text as AreaBasis) ? (text as AreaBasis) : "unknown";
}

function composeAddress(cells: string[], map: Record<string, number>): string | null {
  const full = field(cells, map.fullPropertyIdentifier);
  if (full) return full;
  const parts = ["number", "street", "town", "postalDistrict", "county"]
    .map((k) => field(cells, map[k]))
    .filter((v): v is string => v !== null);
  return parts.length ? parts.join(", ") : null;
}

async function loadList(path: string, limit: number): Promise<void> {
  const map = mapFrom("VOA_LIST_MAP", LIST_MAP);
  const stream = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let read = 0, written = 0, skipped = 0, shown = false;

  for await (const line of stream) {
    if (!line.trim()) continue;
    const cells = line.split("*");
    read += 1;
    if (read > limit) break;

    const uarn = field(cells, map.uarn);
    if (!uarn) { skipped += 1; continue; }

    const record = {
      uarn,
      billingAuthorityCode: field(cells, map.billingAuthorityCode),
      billingAuthorityReference: field(cells, map.billingAuthorityReference),
      primaryDescription: field(cells, map.primaryDescription),
      scatCode: field(cells, map.scatCode),
      propertyAddress: composeAddress(cells, map),
      postcode: normalisePostcode(field(cells, map.postcode) ?? ""),
      rateableValue: num(field(cells, map.rateableValue)),
      effectiveDate: isoDate(field(cells, map.effectiveDate)),
    };

    if (!shown) {
      console.log(`${DIM}first record parsed as:${OFF}`);
      console.log(`${DIM}${JSON.stringify(record, null, 2)}${OFF}`);
      console.log(`${YELLOW}Check this against the file. Wrong? Override VOA_LIST_MAP.${OFF}\n`);
      shown = true;
    }

    await getPool().query(
      `INSERT INTO voa_assessment
         (uarn, billing_authority_code, billing_authority_reference,
          primary_description, scat_code, property_address, postcode,
          rateable_value, effective_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (uarn) DO UPDATE SET
         billing_authority_code = EXCLUDED.billing_authority_code,
         billing_authority_reference = EXCLUDED.billing_authority_reference,
         primary_description = EXCLUDED.primary_description,
         scat_code = EXCLUDED.scat_code,
         property_address = EXCLUDED.property_address,
         postcode = EXCLUDED.postcode,
         rateable_value = EXCLUDED.rateable_value,
         effective_date = EXCLUDED.effective_date,
         loaded_at = now()`,
      [
        record.uarn, record.billingAuthorityCode, record.billingAuthorityReference,
        record.primaryDescription, record.scatCode, record.propertyAddress,
        record.postcode, record.rateableValue, record.effectiveDate,
      ],
    );
    written += 1;
  }

  console.log(`${GREEN}OK${OFF} list: read ${read}, wrote ${written}, skipped ${skipped}`);
}

async function loadSmv(path: string, limit: number): Promise<void> {
  const map = mapFrom("VOA_SMV_MAP", SMV_MAP);
  const stream = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

  let read = 0, written = 0, orphaned = 0, shown = false;
  const lineNo = new Map<string, number>();

  for await (const line of stream) {
    if (!line.trim()) continue;
    const cells = line.split("*");
    read += 1;
    if (read > limit) break;

    const uarn = field(cells, map.uarn);
    const area = num(field(cells, map.areaM2));
    // Survey lines are the rows carrying an area; header records are skipped.
    if (!uarn || area === null) continue;

    const next = (lineNo.get(uarn) ?? 0) + 1;
    lineNo.set(uarn, next);

    const record = {
      uarn,
      lineNo: next,
      description: field(cells, map.lineDescription),
      areaM2: area,
      basis: toBasis(field(cells, map.basis)),
      pricePerM2: num(field(cells, map.pricePerM2)),
      value: num(field(cells, map.value)),
    };

    if (!shown) {
      console.log(`${DIM}first survey line parsed as:${OFF}`);
      console.log(`${DIM}${JSON.stringify(record, null, 2)}${OFF}`);
      console.log(`${YELLOW}Check this against the file. Wrong? Override VOA_SMV_MAP.${OFF}\n`);
      shown = true;
    }

    // A survey line without its assessment would be a floor area with no
    // address to attach it to, so it is counted and dropped rather than stored.
    const { rowCount } = await getPool().query(
      `INSERT INTO voa_survey_line (uarn, line_no, description, area_m2, basis, price_per_m2, value)
       SELECT $1,$2,$3,$4,$5,$6,$7
        WHERE EXISTS (SELECT 1 FROM voa_assessment WHERE uarn = $1)
       ON CONFLICT (uarn, line_no) DO UPDATE SET
         description = EXCLUDED.description, area_m2 = EXCLUDED.area_m2,
         basis = EXCLUDED.basis, price_per_m2 = EXCLUDED.price_per_m2,
         value = EXCLUDED.value`,
      [record.uarn, record.lineNo, record.description, record.areaM2,
       record.basis, record.pricePerM2, record.value],
    );
    if (rowCount) written += 1; else orphaned += 1;
  }

  console.log(`${GREEN}OK${OFF} smv: read ${read}, wrote ${written} survey lines`);
  if (orphaned) {
    console.log(`${YELLOW}${orphaned} lines had no matching assessment - load the list file first.${OFF}`);
  }
}

const [, , kind, path] = process.argv;
const limit = Number(process.env.SITE_INGEST_LIMIT ?? Number.MAX_SAFE_INTEGER);

async function main(): Promise<void> {
  if (!path) throw new Error("Usage: site:load-voa -- <list|smv> <path-to-file>");
  if (kind === "list") await loadList(path, limit);
  else if (kind === "smv") await loadSmv(path, limit);
  else throw new Error(`Unknown kind "${kind}". Use list or smv.`);
  await closePool();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
