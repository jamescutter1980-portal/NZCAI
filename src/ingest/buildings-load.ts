/**
 * OS OpenMap Local building polygons. Brief §3.2.
 *
 *   npm run site:load-buildings -- <buildings.geojson>
 *
 * Download OpenMapLocal from https://osdatahub.os.uk/downloads/open/OpenMapLocal
 * and extract the Building layer as GeoJSON in WGS84.
 *
 * COORDINATE REFERENCE SYSTEM IS THE TRAP HERE. OS publishes OpenMap Local in
 * British National Grid (EPSG:27700), whose coordinates are metres — eastings
 * around 400000, northings around 400000. Everything downstream expects
 * WGS84 longitude/latitude. A BNG file loaded unconverted does not error: it
 * produces polygons at longitude 400000, which fall outside every bbox query
 * and silently match nothing.
 *
 * So the loader REFUSES coordinates that are not plausible WGS84 and says what
 * it found. Reproject before loading (ogr2ogr -t_srs EPSG:4326), rather than
 * hand-rolling a datum shift here — OSTN15 is a grid transformation, not a
 * formula, and an approximate one would move buildings by metres.
 *
 * The file is read as a stream of lines rather than JSON.parse'd whole: a
 * single local authority extract runs to hundreds of MB and the parse would
 * exhaust memory before the first insert.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { closePool, getPool } from "@/lib/db";
import { areaM2, bounds } from "@/lib/site-intel/geo";
import { isEntryPoint } from "./cli";

const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", OFF = "\x1b[0m";

/** Longitude/latitude bounds that comfortably contain the British Isles. */
const UK_BOUNDS = { minLng: -9, maxLng: 2.5, minLat: 49, maxLat: 61.5 };

export interface CrsCheck {
  ok: boolean;
  reason: string | null;
}

/**
 * Is this plausibly WGS84 over the UK?
 *
 * Deliberately a range check rather than a CRS declaration read: the `crs`
 * member was dropped in RFC 7946, plenty of exports omit it, and a wrong
 * declaration is more dangerous than a missing one.
 */
export function checkCrs(west: number, south: number, east: number, north: number): CrsCheck {
  const big = Math.max(Math.abs(west), Math.abs(east), Math.abs(south), Math.abs(north));
  if (big > 180) {
    return {
      ok: false,
      reason:
        `coordinates reach ${Math.round(big)}, which is not longitude or latitude. ` +
        "This looks like British National Grid (EPSG:27700) in metres. Reproject to " +
        "EPSG:4326 first: ogr2ogr -t_srs EPSG:4326 out.geojson in.shp",
    };
  }
  if (
    east < UK_BOUNDS.minLng || west > UK_BOUNDS.maxLng ||
    north < UK_BOUNDS.minLat || south > UK_BOUNDS.maxLat
  ) {
    return {
      ok: false,
      reason:
        `bounding box ${west.toFixed(3)},${south.toFixed(3)} to ${east.toFixed(3)},${north.toFixed(3)} ` +
        "falls outside the British Isles. Check the file and its projection.",
    };
  }
  return { ok: true, reason: null };
}

/**
 * Pulls one Feature object out of a line of a GeoJSON file.
 *
 * Exports vary: some put the whole FeatureCollection on one line, some put one
 * feature per line with a trailing comma. This handles the per-line form and
 * the caller falls back to a whole-file parse for the one-line form.
 */
export function featureFromLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim().replace(/,$/, "");
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return parsed.type === "Feature" && parsed.geometry ? parsed : null;
  } catch {
    return null;
  }
}

const REF_KEYS = ["fid", "FID", "id", "ID", "gml_id", "OBJECTID", "toid", "TOID"];

function refOf(props: Record<string, unknown> | null): string | null {
  if (!props) return null;
  for (const key of REF_KEYS) {
    const value = props[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

async function load(path: string, limit: number): Promise<void> {
  const pool = getPool();
  const started = await pool.query(
    `INSERT INTO building_load (source_file, note) VALUES ($1, $2) RETURNING id`,
    [path, "coordinates range-checked for WGS84; see buildings-load.ts header"],
  );
  const loadId = started.rows[0].id as number;

  let read = 0, loaded = 0, skipped = 0, rejected = 0;
  let printed = false;
  let crsFailed: string | null = null;

  const insert = async (feature: Record<string, unknown>): Promise<void> => {
    const geometry = feature.geometry as GeoJSON.Geometry | null;
    if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
      skipped++;
      return;
    }

    const box = bounds(geometry);
    if (!box) { skipped++; return; }
    const [west, south, east, north] = box;

    const crs = checkCrs(west, south, east, north);
    if (!crs.ok) {
      // The first bad feature stops the load. A partial import of misplaced
      // polygons is worse than none: they match nothing and nothing says why.
      crsFailed = crs.reason;
      return;
    }

    const props = (feature.properties ?? null) as Record<string, unknown> | null;
    const sourceRef = refOf(props);

    if (!printed) {
      console.log(
        `${DIM}first record: ${JSON.stringify({
          sourceRef,
          type: geometry.type,
          bbox: [west.toFixed(5), south.toFixed(5), east.toFixed(5), north.toFixed(5)],
          areaM2: areaM2(geometry),
        })}${OFF}`,
      );
      console.log(`${DIM}Check that against the file before trusting the load.${OFF}`);
      printed = true;
    }

    await pool.query(
      `INSERT INTO os_building
         (source_ref, geometry, min_lat, max_lat, min_lng, max_lng, area_m2, source_file)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
         geometry = EXCLUDED.geometry,
         min_lat = EXCLUDED.min_lat, max_lat = EXCLUDED.max_lat,
         min_lng = EXCLUDED.min_lng, max_lng = EXCLUDED.max_lng,
         area_m2 = EXCLUDED.area_m2, source_file = EXCLUDED.source_file,
         ingested_at = now()`,
      [sourceRef, JSON.stringify(geometry), south, north, west, east, areaM2(geometry), path],
    );
    loaded++;
    if (loaded % 10_000 === 0) console.log(`${DIM}  ${loaded.toLocaleString()} loaded${OFF}`);
  };

  const stream = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  const lines: string[] = [];
  let sawPerLineFeature = false;

  for await (const line of stream) {
    const feature = featureFromLine(line);
    if (feature) {
      sawPerLineFeature = true;
      read++;
      if (read > limit) break;
      await insert(feature);
      if (crsFailed) break;
    } else if (!sawPerLineFeature) {
      // Might be a single-line FeatureCollection; keep it for the fallback.
      lines.push(line);
    }
  }

  if (!sawPerLineFeature && !crsFailed) {
    console.log(`${DIM}no per-line features; parsing the file as one FeatureCollection${OFF}`);
    const parsed = JSON.parse(lines.join("\n")) as { features?: Record<string, unknown>[] };
    for (const feature of parsed.features ?? []) {
      read++;
      if (read > limit) break;
      await insert(feature);
      if (crsFailed) break;
    }
  }

  if (crsFailed) {
    rejected = 1;
    await pool.query(
      `UPDATE building_load SET rows_read = $2, rows_loaded = $3, rows_skipped = $4,
              finished_at = now(), note = $5 WHERE id = $1`,
      [loadId, read, loaded, skipped, `REJECTED: ${crsFailed}`],
    );
    console.log(`\n${RED}STOPPED${OFF} ${crsFailed}`);
    console.log(
      `${DIM}${loaded.toLocaleString()} row(s) were written before the check failed; ` +
      `delete them before retrying: DELETE FROM os_building WHERE source_file = '${path}';${OFF}`,
    );
    return;
  }

  await pool.query(
    `UPDATE building_load SET rows_read = $2, rows_loaded = $3, rows_skipped = $4,
            finished_at = now() WHERE id = $1`,
    [loadId, read, loaded, skipped],
  );

  console.log(
    `${GREEN}loaded${OFF} ${loaded.toLocaleString()} building polygon(s) of ${read.toLocaleString()} read` +
    (skipped ? `, ${YELLOW}${skipped.toLocaleString()} skipped${OFF} (not a polygon)` : "") +
    (rejected ? `, ${RED}${rejected} rejected${OFF}` : ""),
  );
  console.log(
    `${DIM}The footprint store is now live for this area. Coverage is whatever has${OFF}\n` +
    `${DIM}been loaded - a site outside it still reports footprint: unavailable.${OFF}`,
  );
}

async function main(): Promise<void> {
  const [, , path] = process.argv;
  if (!path) {
    console.log("usage: npm run site:load-buildings -- <buildings.geojson>");
    console.log("");
    console.log("OS OpenMap Local, Building layer, reprojected to EPSG:4326:");
    console.log("  ogr2ogr -t_srs EPSG:4326 buildings.geojson Building.shp");
    process.exit(1);
  }

  const limit = Number(process.env.BUILDING_LOAD_LIMIT ?? Number.MAX_SAFE_INTEGER);
  console.log(`Loading building polygons from ${path}`);
  await load(path, limit);
  await closePool();
}

if (isEntryPoint(import.meta.url)) {
  main().catch(async (err) => {
    console.error(err);
    await closePool();
    process.exit(1);
  });
}
