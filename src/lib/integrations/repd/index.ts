import { defineIntegration, makeProvenance, type EnvLike, type IntegrationDefinition, type OperationContext, type OperationResult } from "../framework";
import { csvToRecords, parseNumericCell } from "../_shared/csv";
import { findColumn, normaliseColumn } from "../_shared/columns";
import { osgb36ToWgs84 } from "../_shared/osgb";
import { haversineKm } from "../ea-flood-monitoring/ea-lda";
import { fileVersion, listReferenceFiles, loadReferenceFile, referenceDir, referenceHealth, type ReferenceFile } from "../_shared/reference-data";
import { downloadText, expectedPath, writeCache } from "../gender-pay-gap/download-cache";

/**
 * DESNZ Renewable Energy Planning Database (REPD): the quarterly CSV extract
 * of renewable electricity (and storage) projects of 150 kW and above, from
 * application through to operation.
 *
 * Column layout confirmed from open-source parsers of the extracts
 * (alan-turing-institute/solar-panel-detection, PyPSA-GB,
 * lorenz-g/tesla-megapack-tracker), not from a live download here. The file
 * opens with a group-title row ("General Facility Details,,,...") followed by
 * the header:
 *
 *   Old Ref ID | Ref ID | Record Last Updated (dd/mm/yyyy) | Operator (or Applicant) | Site Name |
 *   Technology Type | Storage Type | Storage Co-location REPD Ref ID | Installed Capacity (MWelec) |
 *   CHP Enabled | RO Banding (ROC/MWh) | FiT Tariff (p/kWh) | CfD Capacity (MW) | Turbine Capacity (MW) |
 *   No. of Turbines | Height of Turbines (m) | Mounting Type for Solar | Development Status |
 *   Development Status (short) | Address | County | Region | Country | Post Code | X-coordinate |
 *   Y-coordinate | Planning Authority | Planning Application Reference | ... | Planning Application Submitted |
 *   ... | Planning Permission Granted | ... | Under Construction | Operational | Heat Network Ref
 *
 * X/Y are OSGB36 National Grid metres (often quoted with thousands
 * separators, "302,219"); Northern Ireland rows use the Irish Grid and are
 * not converted. Columns are matched by normalised name so renamed releases
 * still load.
 */

export const ID = "repd";
export const FILE_PATTERN = /^repd.*\.csv$/i;

/** Q2 2026 extract (published 3 August 2026): URL recorded by several open-source projects; not fetched from this codebase. */
export const DEFAULT_CSV_URL = "https://assets.publishing.service.gov.uk/media/6a6cbdc00c36759b5ccaa305/REPD_Publication_Q2_2026.csv";
export const DEFAULT_FILE_NAME = "repd-q2-2026.csv";

export type RepdProject = {
  ref_id: string;
  site_name: string;
  operator: string;
  technology: string;
  storage_type: string;
  capacity_mw: number | null;
  status_short: string;
  status: string;
  address: string;
  county: string;
  region: string;
  country: string;
  postcode: string;
  easting: number | null;
  northing: number | null;
  latitude: number | null;
  longitude: number | null;
  planning_authority: string;
  application_reference: string;
  application_submitted: string;
  permission_granted: string;
  under_construction: string;
  operational: string;
  record_last_updated: string;
  mounting_type: string;
  turbines: number | null;
}

export interface RepdIndex {
  file: ReferenceFile;
  header: string[];
  projects: RepdProject[];
  /** Rows whose Country is Northern Ireland (Irish Grid; no lat/lon computed). */
  northernIreland: number;
  /** Rows with no usable grid reference. */
  noCoordinates: number;
  /** Lower-cased searchable text per project, same order. */
  haystack: string[];
}

export const COLUMNS: (keyof RepdProject | "distance_km")[] = ["ref_id", "site_name", "operator", "technology", "storage_type", "capacity_mw", "status_short", "status", "distance_km", "address", "county", "region", "country", "postcode", "latitude", "longitude", "easting", "northing", "planning_authority", "application_reference", "application_submitted", "permission_granted", "under_construction", "operational", "record_last_updated", "mounting_type", "turbines"];

const SPEC: Record<string, string[]> = {
  ref_id: ["Ref ID"],
  site_name: ["Site Name"],
  operator: ["Operator (or Applicant)", "Operator"],
  technology: ["Technology Type"],
  storage_type: ["Storage Type"],
  capacity: ["Installed Capacity (MWelec)", "Installed Capacity (MW)"],
  status_short: ["Development Status (short)"],
  status: ["Development Status"],
  address: ["Address"],
  county: ["County"],
  region: ["Region"],
  country: ["Country"],
  postcode: ["Post Code", "Postcode"],
  x: ["X-coordinate", "X coordinate", "Easting"],
  y: ["Y-coordinate", "Y coordinate", "Northing"],
  planning_authority: ["Planning Authority"],
  application_reference: ["Planning Application Reference"],
  application_submitted: ["Planning Application Submitted"],
  permission_granted: ["Planning Permission Granted"],
  under_construction: ["Under Construction"],
  operational: ["Operational"],
  record_last_updated: ["Record Last Updated (dd/mm/yyyy)", "Record Last Updated*"],
  mounting_type: ["Mounting Type for Solar"],
  turbines: ["No. of Turbines"],
};

/** REPD addresses are multi-line with a leading comma on continuation lines ("Line 1\n, Line 2\n"). */
export function cleanAddress(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^,\s*/, "").replace(/\s*,$/, ""))
    .filter(Boolean)
    .join(", ");
}

export function isNorthernIreland(country: string): boolean {
  return /northern\s+ireland/i.test(country);
}

export function parseRepd(text: string, file: ReferenceFile): RepdIndex {
  const table = csvToRecords(text, { isHeader: (row) => row.some((c) => normaliseColumn(c) === "ref_id") });
  const header = table.header;
  const col: Record<string, string | undefined> = {};
  for (const [key, candidates] of Object.entries(SPEC)) {
    const i = findColumn(header, candidates);
    col[key] = i >= 0 ? header[i] : undefined;
  }
  const required = ["ref_id", "site_name", "technology", "capacity", "status_short", "x", "y"];
  const missing = required.filter((k) => !col[k]);
  if (missing.length) throw new Error(`${file.name}: missing columns ${missing.join(", ")}. Expected the REPD quarterly extract CSV (Ref ID, Site Name, Technology Type, Installed Capacity (MWelec), Development Status (short), X-coordinate, Y-coordinate ...).`);
  const get = (r: Record<string, string>, key: string) => (col[key] ? (r[col[key]!] ?? "").trim() : "");
  const projects: RepdProject[] = [];
  let northernIreland = 0;
  let noCoordinates = 0;
  for (const r of table.records) {
    const refId = get(r, "ref_id");
    if (!refId) continue;
    const country = get(r, "country");
    const easting = parseNumericCell(get(r, "x"));
    const northing = parseNumericCell(get(r, "y"));
    let latitude: number | null = null;
    let longitude: number | null = null;
    if (isNorthernIreland(country)) northernIreland++;
    else if (easting === null || northing === null) noCoordinates++;
    else {
      const ll = osgb36ToWgs84(easting, northing);
      if (ll) {
        latitude = ll.latitude;
        longitude = ll.longitude;
      } else noCoordinates++;
    }
    projects.push({
      ref_id: refId,
      site_name: get(r, "site_name"),
      operator: get(r, "operator"),
      technology: get(r, "technology"),
      storage_type: get(r, "storage_type"),
      capacity_mw: parseNumericCell(get(r, "capacity")),
      status_short: get(r, "status_short"),
      status: get(r, "status"),
      address: cleanAddress(get(r, "address")),
      county: get(r, "county"),
      region: get(r, "region"),
      country,
      postcode: get(r, "postcode"),
      easting,
      northing,
      latitude,
      longitude,
      planning_authority: get(r, "planning_authority"),
      application_reference: get(r, "application_reference"),
      application_submitted: get(r, "application_submitted"),
      permission_granted: get(r, "permission_granted"),
      under_construction: get(r, "under_construction"),
      operational: get(r, "operational"),
      record_last_updated: get(r, "record_last_updated"),
      mounting_type: get(r, "mounting_type"),
      turbines: parseNumericCell(get(r, "turbines")),
    });
  }
  const haystack = projects.map((p) => [p.site_name, p.operator, p.technology, p.storage_type, p.status_short, p.status, p.address, p.county, p.region, p.country, p.postcode, p.planning_authority].join(" | ").toLowerCase());
  return { file, header, projects, northernIreland, noCoordinates, haystack };
}

/** All loaded extracts, newest modification first. */
export function loadExtracts(env: EnvLike): RepdIndex[] {
  return listReferenceFiles(env, ID, FILE_PATTERN)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .map((file) => loadReferenceFile(file, (text) => parseRepd(text, file)));
}

export function publicationLinks() {
  return [
    { label: "Renewable Energy Planning Database: quarterly extract (gov.uk)", url: "https://www.gov.uk/government/publications/renewable-energy-planning-database-monthly-extract" },
    { label: "REPD on data.gov.uk (historic extracts)", url: "https://www.data.gov.uk/dataset/a5b0ed13-c960-49ce-b1f6-3a6bbe0db1b7/renewable-energy-planning-database-repd" },
    { label: "Q2 2026 CSV (as recorded by third parties; not fetched here)", url: DEFAULT_CSV_URL },
  ];
}

function noFileResult(def: IntegrationDefinition, ctx: OperationContext): OperationResult {
  return {
    summary: `No REPD extract loaded. Run the download operation or save the quarterly CSV as ${expectedPath(ctx.env, ID, DEFAULT_FILE_NAME)} (any repd*.csv name is read; the most recently modified file is used).`,
    columns: COLUMNS,
    rows: [],
    provenance: makeProvenance(def, ctx, { dataset: "quarterly-extract", basis: "unavailable" }),
    links: publicationLinks(),
  };
}

function matches(p: RepdProject, hay: string, technology?: string, status?: string, area?: string, minCapacity?: number): boolean {
  if (technology && !p.technology.toLowerCase().includes(technology)) return false;
  if (status && !p.status_short.toLowerCase().includes(status) && !p.status.toLowerCase().includes(status)) return false;
  if (area && !hay.includes(area)) return false;
  if (minCapacity !== undefined && (p.capacity_mw === null || p.capacity_mw < minCapacity)) return false;
  return true;
}

function lower(v: unknown): string | undefined {
  const s = v === undefined || v === null ? "" : String(v).trim().toLowerCase();
  return s || undefined;
}

const WARN_REPD = "REPD covers renewable electricity and storage projects of 150 kW and above that pass through planning; small rooftop PV and many sub-150 kW installations are absent. Statuses and capacities are as recorded by DESNZ at the extract date (installed capacity is MW electrical, as applied for or consented).";
const WARN_COORDS = "Locations are OSGB36 grid references converted to WGS84 with a Helmert transform (about 5 m); they mark the site as recorded, not necessarily the grid connection point.";

const TECH_PARAM = { name: "technology", label: "Technology contains", type: "string" as const, placeholder: "Solar Photovoltaics", help: "Case-insensitive match on Technology Type, e.g. Solar Photovoltaics, Wind Onshore, Battery, Biomass, Landfill Gas, Hydro." };
const STATUS_PARAM = { name: "status", label: "Status contains", type: "string" as const, placeholder: "Operational", help: "Case-insensitive match on Development Status (short), e.g. Operational, Under Construction, Awaiting Construction, Application Submitted, Application Refused, Abandoned." };
const LIMIT_PARAM = { name: "limit", label: "Max rows", type: "integer" as const, default: 50, min: 1, max: 100 };

export const definition = defineIntegration({
  id: ID,
  name: "DESNZ Renewable Energy Planning Database (REPD)",
  group: "solar",
  access: "download",
  territory: "UK",
  description: "Quarterly extract of renewable electricity and storage projects of 150 kW and above through planning, with site location, technology, capacity and status. Searched by distance from a point or by technology, status and area, from the CSV saved locally.",
  docsUrl: "https://www.gov.uk/government/publications/renewable-energy-planning-database-monthly-extract",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Department for Energy Security and Net Zero, Renewable Energy Planning Database.",
  licence: "OGL",
  envVars: [
    { name: "REFERENCE_DATA_DIR", required: false, description: `Directory holding reference files (default data/reference). The extract is read from <dir>/${ID}/repd*.csv (most recently modified file wins).` },
    { name: "REPD_CSV_URL", required: false, description: "Overrides the built-in CSV download URL (copy the CSV link from the gov.uk quarterly extract page)." },
  ],
  status: "built_unverified",
  notes: [
    `Supply the file: download the CSV from the gov.uk quarterly extract page and save it as data/reference/repd/${DEFAULT_FILE_NAME} (any name starting with 'repd' and ending '.csv' is read), or run the download operation. The built-in URL is the Q2 2026 CSV as recorded by several open-source projects; it has not been fetched from this codebase and each quarter's URL changes, so set REPD_CSV_URL or the url parameter for later releases.`,
    "Column layout (group-title row, then Ref ID, Site Name, Technology Type, Storage Type, Installed Capacity (MWelec), Development Status (short), Address, County, Region, Country, Post Code, X-coordinate, Y-coordinate, Planning Authority, planning milestone dates ...) is confirmed from open-source parsers of the 2019-2026 extracts, not from a live download. Columns are matched by normalised name.",
    "X/Y coordinates are OSGB36 National Grid metres (sometimes with thousands separators). They are converted to WGS84 for the distance search. Northern Ireland rows use the Irish Grid (TM75) and are skipped from the distance search with a warning; they still appear in the technology/status search with no lat/lon.",
    "Some releases are not valid UTF-8 (Windows-1252 bytes in addresses). The file is read as UTF-8; odd bytes become replacement characters but do not break parsing. Some cells carry spreadsheet serial numbers instead of dates; dates are shown as printed.",
    WARN_REPD,
    WARN_COORDS,
  ],
  healthCheck: referenceHealth(ID, FILE_PATTERN, "repd-<quarter>.csv"),
  operations: [
    {
      id: "nearby",
      label: "Projects near a point",
      description: "Renewable and storage projects within a radius of a point, nearest first, with optional technology and status filters.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "53.4808" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-2.2426" },
        { name: "radius_km", label: "Radius (km)", type: "number", default: 10, min: 0.1, max: 100 },
        TECH_PARAM,
        STATUS_PARAM,
        LIMIT_PARAM,
      ],
      async run(params, ctx) {
        const [idx] = loadExtracts(ctx.env);
        if (!idx) return noFileResult(definition, ctx);
        const lat = Number(params.latitude);
        const lon = Number(params.longitude);
        const radius = Number(params.radius_km ?? 10);
        const limit = Number(params.limit ?? 50);
        const technology = lower(params.technology);
        const status = lower(params.status);
        const hits: (RepdProject & { distance_km: number })[] = [];
        idx.projects.forEach((p, i) => {
          if (p.latitude === null || p.longitude === null) return;
          if (!matches(p, idx.haystack[i], technology, status)) return;
          const d = haversineKm(lat, lon, p.latitude, p.longitude);
          if (d <= radius) hits.push({ ...p, distance_km: Math.round(d * 100) / 100 });
        });
        hits.sort((a, b) => a.distance_km - b.distance_km);
        const rows = hits.slice(0, limit);
        const capacity = hits.reduce((a, h) => a + (h.capacity_mw ?? 0), 0);
        const operational = hits.filter((h) => /^operational$/i.test(h.status_short)).length;
        const warnings = [WARN_REPD, WARN_COORDS];
        if (idx.northernIreland) warnings.push(`${idx.northernIreland} Northern Ireland projects in the extract use the Irish Grid and are excluded from the distance search.`);
        if (idx.noCoordinates) warnings.push(`${idx.noCoordinates} projects have no usable grid reference and are excluded from the distance search.`);
        if (hits.length > rows.length) warnings.push(`${hits.length} projects within ${radius} km; showing the nearest ${rows.length}.`);
        return {
          summary: hits.length === 0 ? `No REPD projects within ${radius} km of ${lat}, ${lon}${technology ? ` matching technology "${params.technology}"` : ""}${status ? ` with status "${params.status}"` : ""}.` : `${hits.length} project(s) within ${radius} km of ${lat}, ${lon} totalling ${Math.round(capacity * 10) / 10} MW; ${operational} operational. Nearest: ${rows[0].site_name} (${rows[0].technology}, ${rows[0].capacity_mw ?? "n/a"} MW, ${rows[0].status_short}) at ${rows[0].distance_km} km.`,
          columns: COLUMNS,
          rows,
          raw: { file: idx.file.name, totalWithinRadius: hits.length, totalCapacityMw: capacity },
          provenance: makeProvenance(definition, ctx, { dataset: "quarterly-extract", basis: hits.length ? "measured" : "unavailable", version: fileVersion(idx.file) }),
          warnings,
          links: publicationLinks().slice(0, 1),
        };
      },
    },
    {
      id: "search",
      label: "Projects by technology, status and area",
      description: "Filter the extract by technology, development status, area text (county, region, country, planning authority, postcode, operator) and minimum capacity.",
      params: [
        TECH_PARAM,
        STATUS_PARAM,
        { name: "area", label: "Area or operator contains", type: "string", placeholder: "Greater Manchester", help: "Case-insensitive match on address, county, region, country, post code, planning authority or operator." },
        { name: "min_capacity_mw", label: "Minimum capacity (MW)", type: "number", min: 0 },
        LIMIT_PARAM,
      ],
      async run(params, ctx) {
        const [idx] = loadExtracts(ctx.env);
        if (!idx) return noFileResult(definition, ctx);
        const technology = lower(params.technology);
        const status = lower(params.status);
        const area = lower(params.area);
        const minCapacity = params.min_capacity_mw === undefined ? undefined : Number(params.min_capacity_mw);
        const limit = Number(params.limit ?? 50);
        if (!technology && !status && !area && minCapacity === undefined) throw new Error("Give at least one filter: technology, status, area or minimum capacity.");
        const hits: RepdProject[] = [];
        idx.projects.forEach((p, i) => {
          if (matches(p, idx.haystack[i], technology, status, area, minCapacity)) hits.push(p);
        });
        hits.sort((a, b) => (b.capacity_mw ?? -1) - (a.capacity_mw ?? -1));
        const rows = hits.slice(0, limit).map((p) => ({ ...p, distance_km: null }));
        const capacity = hits.reduce((a, h) => a + (h.capacity_mw ?? 0), 0);
        const warnings = [WARN_REPD];
        if (hits.length > rows.length) warnings.push(`${hits.length} projects matched; showing the ${rows.length} largest by capacity.`);
        if (hits.some((h) => isNorthernIreland(h.country))) warnings.push("Northern Ireland rows carry Irish Grid coordinates and no latitude/longitude.");
        return {
          summary: hits.length === 0 ? "No REPD projects match the filters." : `${hits.length} project(s) match, totalling ${Math.round(capacity * 10) / 10} MW. Largest: ${hits[0].site_name} (${hits[0].technology}, ${hits[0].capacity_mw ?? "n/a"} MW, ${hits[0].status_short}, ${hits[0].country}).`,
          columns: COLUMNS,
          rows,
          raw: { file: idx.file.name, totalMatches: hits.length, totalCapacityMw: capacity },
          provenance: makeProvenance(definition, ctx, { dataset: "quarterly-extract", basis: hits.length ? "measured" : "unavailable", version: fileVersion(idx.file) }),
          warnings,
        };
      },
    },
    {
      id: "download",
      label: "Download the latest extract",
      description: "Downloads the quarterly CSV (built-in Q2 2026 URL, REPD_CSV_URL, or the url parameter) into the reference directory.",
      params: [
        { name: "url", label: "CSV URL (optional override)", type: "string", placeholder: DEFAULT_CSV_URL, help: "Copy the CSV link from the gov.uk quarterly extract page for a newer release." },
        { name: "name", label: "Save as", type: "string", placeholder: DEFAULT_FILE_NAME, help: "File name under data/reference/repd/, must start with 'repd' and end '.csv'." },
      ],
      async run(params, ctx) {
        const url = (params.url as string | undefined)?.trim() || ctx.env.REPD_CSV_URL?.trim() || DEFAULT_CSV_URL;
        const name = (params.name as string | undefined)?.trim() || DEFAULT_FILE_NAME;
        if (!FILE_PATTERN.test(name) || name.includes("/") || name.includes("\\")) throw new Error(`File name must match repd*.csv (got ${name}).`);
        const text = await downloadText(ctx, url, 180_000);
        if (!/ref id/i.test(text.slice(0, 5000)) || !/technology type/i.test(text.slice(0, 5000))) throw new Error(`Downloaded content from ${url} does not look like a REPD CSV (no 'Ref ID' / 'Technology Type' header).`);
        const file = writeCache(ctx.env, ID, name, text);
        const idx = loadReferenceFile(file, (t) => parseRepd(t, file));
        return {
          summary: `Downloaded ${idx.projects.length} REPD projects to ${file.path} (${idx.northernIreland} in Northern Ireland without WGS84 coordinates).`,
          columns: ["file", "projects", "northern_ireland", "no_coordinates", "path", "url"],
          rows: [{ file: file.name, projects: idx.projects.length, northern_ireland: idx.northernIreland, no_coordinates: idx.noCoordinates, path: file.path, url }],
          raw: { url, path: file.path, header: idx.header },
          provenance: makeProvenance(definition, ctx, { dataset: "quarterly-extract", basis: "measured", version: fileVersion(file) }),
        };
      },
    },
    {
      id: "files",
      label: "Loaded extracts",
      description: "Which REPD CSVs are present, with project counts by status.",
      params: [],
      async run(_params, ctx) {
        const extracts = loadExtracts(ctx.env);
        const rows = extracts.map((x) => {
          const byStatus = new Map<string, number>();
          for (const p of x.projects) byStatus.set(p.status_short || "(blank)", (byStatus.get(p.status_short || "(blank)") ?? 0) + 1);
          return {
            file: x.file.name,
            in_use: x === extracts[0],
            projects: x.projects.length,
            northern_ireland: x.northernIreland,
            no_coordinates: x.noCoordinates,
            by_status: [...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join("; "),
            modified_at: x.file.modifiedAt,
            size_bytes: x.file.sizeBytes,
          };
        });
        return {
          summary: rows.length === 0 ? `No extracts in ${referenceDir(ctx.env, ID)}. Expected repd-<quarter>.csv.` : `${rows.length} extract(s) loaded; using ${rows[0].file} (${rows[0].projects} projects).`,
          columns: ["file", "in_use", "projects", "northern_ireland", "no_coordinates", "by_status", "modified_at", "size_bytes"],
          rows,
          provenance: makeProvenance(definition, ctx, { dataset: "quarterly-extract", basis: rows.length ? "measured" : "unavailable" }),
          links: publicationLinks(),
        };
      },
    },
    {
      id: "links",
      label: "Publication pages",
      description: "gov.uk and data.gov.uk pages for the REPD extracts.",
      params: [],
      async run(_params, ctx) {
        const links = publicationLinks();
        return {
          summary: "REPD is published quarterly as a CSV and XLSX; save the CSV under data/reference/repd/ or use the download operation.",
          columns: ["label", "url"],
          rows: links.map((l) => ({ ...l })),
          links,
          provenance: makeProvenance(definition, ctx, { dataset: "publications", basis: "not_applicable" }),
        };
      },
    },
  ],
});
