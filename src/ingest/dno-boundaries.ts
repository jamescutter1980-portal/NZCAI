/**
 * NESO DNO licence-area boundaries — brief §5.1.
 *
 *   npm run grid:boundaries -- <boundaries.geojson>
 *   npm run grid:boundaries -- --url <url>
 *
 * Source: the NESO data portal, "GIS Boundaries for GB DNO Licence Areas".
 *
 * WHY THIS EXISTS. "Which DNO serves this site" was previously answered by
 * whichever substation happened to be nearest. That is a different question
 * with a frequently different answer: licence areas are administrative
 * boundaries, and a site near one can easily have its nearest substation on the
 * other side of it. The brief is specific — point-in-polygon — and the version
 * date is stored because a boundary that moved is a different answer.
 *
 * NOT VERIFIED AGAINST THE REAL FILE. Outbound access was blocked throughout
 * this build. The loader reads standard GeoJSON, prints every feature it finds
 * with the property keys it used to name and match it, and reports areas it
 * could not map to a known DNO rather than dropping them.
 */
import { readFileSync } from "node:fs";
import { closePool, getPool } from "@/lib/db";
import { asAreaGeometry, bboxOf } from "@/lib/geo-polygon";
import { DNOS } from "./registry";
import { isEntryPoint } from "./cli";

const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", OFF = "\x1b[0m";

interface Feature {
  type?: string;
  properties?: Record<string, unknown>;
  geometry?: unknown;
}

/** Property keys NESO might use for the area name, best first. */
const NAME_KEYS = [
  "Name", "name", "DNO_Full", "dno_full", "LongName", "DNO", "dno",
  "Area", "area", "licence_area", "LicenceArea",
];

const REF_KEYS = ["ID", "id", "DNO", "dno", "Licence", "licence_ref", "MPAN_prefix", "mpan"];
const DATE_KEYS = ["version_date", "versionDate", "Date", "date", "published", "last_updated"];

export function firstString(
  props: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = props[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

/**
 * Matches a NESO area name to a DNO in our registry.
 *
 * Deliberately conservative: an unmatched area is stored with a null dno_id and
 * reported, because a wrong DNO on a connection enquiry is worse than none.
 */
export function matchDno(areaName: string): string | null {
  const text = areaName.toLowerCase();
  const rules: [RegExp, string][] = [
    [/national grid|western power|nged|midlands|south wales|south west/, "nged"],
    [/uk power networks|ukpn|eastern|london|south eastern/, "ukpn"],
    [/northern powergrid|npg|yorkshire|north east/, "npg"],
    [/scottish and southern|ssen|sse |southern electric|hydro/, "ssen"],
    [/electricity north west|enwl|north west/, "enwl"],
    [/sp energy|scottish power|spen|manweb|sp distribution/, "spen"],
  ];
  for (const [pattern, id] of rules) {
    if (pattern.test(text)) return id;
  }
  return null;
}

async function load(features: Feature[], sourceRef: string): Promise<void> {
  const pool = getPool();
  let loaded = 0, skipped = 0;
  const unmatched: string[] = [];

  for (const feature of features) {
    const props = feature.properties ?? {};
    const geometry = asAreaGeometry(feature.geometry);

    if (!geometry) {
      skipped++;
      continue;
    }

    const areaName = firstString(props, NAME_KEYS);
    if (!areaName) {
      console.log(
        `  ${YELLOW}skip${OFF} a feature has no recognisable name. ` +
        `Keys present: ${Object.keys(props).slice(0, 12).join(", ")}`,
      );
      skipped++;
      continue;
    }

    const dnoId = matchDno(areaName);
    if (!dnoId) unmatched.push(areaName);

    const bbox = bboxOf(geometry);
    const versionDate = firstString(props, DATE_KEYS);

    await pool.query(
      `INSERT INTO dno_licence_area
         (dno_id, area_name, licence_ref, geometry,
          min_lat, max_lat, min_lng, max_lng, version_date, source_ref, ingested_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (area_name, source_ref) DO UPDATE SET
         dno_id = EXCLUDED.dno_id, licence_ref = EXCLUDED.licence_ref,
         geometry = EXCLUDED.geometry,
         min_lat = EXCLUDED.min_lat, max_lat = EXCLUDED.max_lat,
         min_lng = EXCLUDED.min_lng, max_lng = EXCLUDED.max_lng,
         version_date = EXCLUDED.version_date, ingested_at = now()`,
      [
        dnoId, areaName, firstString(props, REF_KEYS), JSON.stringify(geometry),
        bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng,
        versionDate && !Number.isNaN(new Date(versionDate).getTime()) ? versionDate : null,
        sourceRef,
      ],
    );

    console.log(
      `  ${GREEN}ok${OFF}   ${areaName}${DIM} -> ${dnoId ?? "UNMATCHED"}, ` +
      `bbox ${bbox.minLat.toFixed(2)}..${bbox.maxLat.toFixed(2)} lat${OFF}`,
    );
    loaded++;
  }

  console.log(`\n${GREEN}loaded${OFF} ${loaded} licence area(s)${skipped ? `, ${YELLOW}${skipped} skipped${OFF}` : ""}`);

  if (unmatched.length) {
    console.log(
      `${YELLOW}unmatched${OFF} ${unmatched.length} area(s) did not map to a known DNO:\n` +
      unmatched.map((n) => `  ${n}`).join("\n") +
      `\n${DIM}They are stored with a null dno_id. Add a pattern to matchDno() in${OFF}` +
      `\n${DIM}src/ingest/dno-boundaries.ts - a site in one of these returns "no DNO${OFF}` +
      `\n${DIM}matched" rather than a wrong one, which is the safe failure.${OFF}`,
    );
  }
  console.log(`${DIM}Known DNO ids: ${DNOS.map((d) => d.id).join(", ")}${OFF}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const urlIndex = args.indexOf("--url");
  const path = urlIndex === -1 ? args[0] : undefined;
  const url = urlIndex === -1 ? undefined : args[urlIndex + 1];

  if (!path && !url) {
    console.log("usage: npm run grid:boundaries -- <boundaries.geojson>");
    console.log("       npm run grid:boundaries -- --url <url>");
    console.log("");
    console.log('Source: NESO data portal, "GIS Boundaries for GB DNO Licence Areas".');
    process.exit(1);
  }

  let body: string;
  let sourceRef: string;
  if (url) {
    console.log(`Fetching ${url}`);
    const res = await fetch(url, { headers: { accept: "application/geo+json, application/json" } });
    if (!res.ok) {
      console.log(`${RED}FAIL${OFF} HTTP ${res.status} ${res.statusText}`);
      process.exit(1);
    }
    body = await res.text();
    sourceRef = url;
  } else {
    body = readFileSync(path as string, "utf8");
    sourceRef = path as string;
  }

  const parsed = JSON.parse(body) as { type?: string; features?: Feature[] };
  const features = parsed.features ?? (parsed.type === "Feature" ? [parsed as Feature] : []);
  if (!features.length) {
    console.log(`${RED}FAIL${OFF} no GeoJSON features found`);
    process.exit(1);
  }

  console.log(`${features.length} feature(s) from ${sourceRef}\n`);
  await load(features, sourceRef);
  await closePool();
}

// Guarded: this module exports `matchDno` and `firstString`, and importing
// them must not run the loader. See cli.ts.
if (isEntryPoint(import.meta.url)) {
  main().catch(async (err) => {
    console.error(err);
    await closePool();
    process.exit(1);
  });
}
