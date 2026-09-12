import { buildUrl, defineIntegration, fetchJson, fetchText, IntegrationHttpError, makeProvenance, simpleHealth, type OperationResult } from "../framework";
import { csvToRecords } from "../_shared/csv";

/**
 * Environment Agency Catchment Data Explorer (Water Framework Directive
 * classifications, reasons for not achieving good status).
 * Base: https://environment.data.gov.uk/catchment-planning/
 *
 * What is confirmed from public use (DEFRA water-availability-poc and other
 * open-source clients):
 *   WaterBody/{id}.geojson                      geometry + id/name/uri/water-body-type
 *   OperationalCatchment/{id}/classifications.csv  all classification rows
 *   OperationalCatchment/{id}/rnags.csv          reasons for not achieving good
 *   WaterBody/{id}                               human-readable page
 * The documented Catchment Data API (/catchment-planning/api/docs) also
 * describes JSON routes, but a probe by a third party found extension-bearing
 * URLs returning HTML with HTTP 200, so JSON detail is fetched defensively and
 * a lat/long water-body lookup is NOT provided: it could not be confirmed.
 */

export const BASE = "https://environment.data.gov.uk/catchment-planning";

interface GeoJsonFeature {
  type?: string;
  properties?: Record<string, unknown>;
  geometry?: { type?: string };
}
interface GeoJson {
  type?: string;
  features?: GeoJsonFeature[];
  properties?: Record<string, unknown>;
}

function prop(props: Record<string, unknown> | undefined, ...names: string[]): unknown {
  if (!props) return null;
  const lower = new Map(Object.keys(props).map((k) => [k.toLowerCase().replace(/[\s_-]/g, ""), k]));
  for (const n of names) {
    const key = lower.get(n.toLowerCase().replace(/[\s_-]/g, ""));
    if (key !== undefined && props[key] !== null && props[key] !== undefined && props[key] !== "") return props[key];
  }
  return null;
}

const WB_COLUMNS = ["water_body_id", "name", "water_body_type", "geometry_type", "features", "uri", "page"];

export function waterBodyRows(id: string, data: GeoJson) {
  const features = data.features ?? (data.type === "Feature" ? [data as GeoJsonFeature] : []);
  return features.map((f) => ({
    water_body_id: String(prop(f.properties, "id", "water-body-id", "waterBodyId", "notation") ?? id),
    name: String(prop(f.properties, "name", "label") ?? ""),
    water_body_type: String(prop(f.properties, "water-body-type", "waterBodyType", "type") ?? ""),
    geometry_type: f.geometry?.type ?? null,
    features: features.length,
    uri: String(prop(f.properties, "uri", "@id") ?? ""),
    page: `${BASE}/WaterBody/${encodeURIComponent(id)}`,
  }));
}

const CLASS_COLUMNS = ["water_body_id", "water_body", "classification_item", "status", "year", "cycle", "classification_level", "water_body_type", "hydromorphological_designation"];

function col(rec: Record<string, string>, ...names: string[]): string {
  const lower = new Map(Object.keys(rec).map((k) => [k.toLowerCase().replace(/[\s_-]/g, ""), k]));
  for (const n of names) {
    const key = lower.get(n.toLowerCase().replace(/[\s_-]/g, ""));
    if (key !== undefined && rec[key] !== "") return rec[key];
  }
  return "";
}

export function classificationRows(csv: string, opts: { waterBodyId?: string; latestOnly?: boolean } = {}) {
  const { records } = csvToRecords(csv);
  let rows = records.map((r) => ({
    water_body_id: col(r, "Water Body ID", "waterBodyId"),
    water_body: col(r, "Water Body", "Water Body Name", "waterBody"),
    classification_item: col(r, "Classification Item", "classificationItem"),
    status: col(r, "Status", "Classification Status", "classificationStatus"),
    year: col(r, "Year", "Classification Year"),
    cycle: col(r, "Cycle"),
    classification_level: col(r, "Classification Level", "classificationLevel"),
    water_body_type: col(r, "Water Body Type", "waterBodyType"),
    hydromorphological_designation: col(r, "Hydromorphological designation", "Hydromorphological Designation"),
  }));
  if (opts.waterBodyId) rows = rows.filter((r) => r.water_body_id.toLowerCase() === opts.waterBodyId!.toLowerCase());
  if (opts.latestOnly) {
    const latest = new Map<string, number>();
    for (const r of rows) {
      const y = Number(r.year);
      if (Number.isFinite(y)) latest.set(r.water_body_id, Math.max(latest.get(r.water_body_id) ?? 0, y));
    }
    rows = rows.filter((r) => Number(r.year) === latest.get(r.water_body_id));
  }
  return rows;
}

export const definition = defineIntegration({
  id: "ea-catchment-data",
  name: "EA Catchment Data Explorer (WFD classifications)",
  group: "flood_water",
  access: "open",
  territory: "England",
  description: "Water Framework Directive water bodies, their ecological and chemical classifications and reasons for not achieving good status, from the Environment Agency Catchment Data Explorer.",
  docsUrl: "https://environment.data.gov.uk/catchment-planning/api/docs",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains Environment Agency data © Environment Agency and database right. Contains public sector information licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "A water-body-near-a-point query could not be confirmed against the published API, so lookups are by water body id (GBxxxxxxxxxxxx) and operational catchment id. Find ids on the Catchment Data Explorer map; the England-wide GeoJSON (England.geojson, ~8,700 features) is too large to fetch per request.",
    "A third-party probe found that .json/.ttl routes returned HTML with HTTP 200; this connector uses the GeoJSON and CSV surfaces that are known to work and checks content types.",
    "Classifications are WFD reporting statuses (High, Good, Moderate, Poor, Bad; chemical Good/Fail) per cycle and year. They describe the water body, not a site's discharge.",
    "Classification CSV column names were confirmed from a published analysis of the CSV export (Water Body ID, Classification Item, Status, Year, Cycle, Classification Level); other columns are matched loosely.",
  ],
  healthCheck: simpleHealth(BASE + "/"),
  operations: [
    {
      id: "water-body",
      label: "Water body by id",
      description: "Name, type and geometry summary for one WFD water body, with a link to its Catchment Data Explorer page.",
      params: [{ name: "waterBodyId", label: "Water body id", type: "string", required: true, placeholder: "GB106039023090", help: "WFD water body id starting GB, from the Catchment Data Explorer." }],
      async run(params, ctx): Promise<OperationResult> {
        const id = String(params.waterBodyId).trim();
        if (!/^GB[A-Z0-9]{6,20}$/i.test(id)) throw new Error("water body id should look like GB106039023090");
        const url = buildUrl(BASE, `WaterBody/${encodeURIComponent(id)}.geojson`);
        const { data, status } = await fetchJson<GeoJson>(ctx, url, { headers: { accept: "application/geo+json, application/json" } }, { acceptStatuses: [404] });
        const rows = status === 404 || !data ? [] : waterBodyRows(id, data);
        return {
          summary: rows.length ? `${rows[0].name || id} (${rows[0].water_body_type || "type unknown"}); ${rows.length} geometry feature${rows.length > 1 ? "s" : ""}.` : `Water body ${id} not found.`,
          columns: WB_COLUMNS,
          rows,
          raw: data ? { type: data.type, featureCount: data.features?.length, properties: data.features?.map((f) => f.properties) } : null,
          provenance: makeProvenance(definition, ctx, { dataset: "catchment-planning/WaterBody.geojson", basis: rows.length ? "measured" : "unavailable" }),
          links: [{ label: `${id} on Catchment Data Explorer`, url: `${BASE}/WaterBody/${encodeURIComponent(id)}` }],
        };
      },
    },
    {
      id: "catchment-classifications",
      label: "WFD classifications for an operational catchment",
      description: "Latest overall, ecological and chemical classification rows for every water body in an operational catchment (optionally one water body).",
      params: [
        { name: "catchmentId", label: "Operational catchment id", type: "integer", required: true, placeholder: "3367", help: "Numeric id from the Catchment Data Explorer URL, e.g. 3367 (Poole Harbour Rivers)." },
        { name: "waterBodyId", label: "Water body id (optional)", type: "string", required: false, placeholder: "GB108044009890" },
        { name: "allYears", label: "Include all years", type: "boolean", default: false },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const cid = Number(params.catchmentId);
        const url = buildUrl(BASE, `OperationalCatchment/${cid}/classifications.csv`);
        const { text, status } = await fetchText(ctx, url, { headers: { accept: "text/csv" } }, { acceptStatuses: [404], timeoutMs: 60_000 });
        if (status === 404) {
          return { summary: `Operational catchment ${cid} not found.`, columns: CLASS_COLUMNS, rows: [], provenance: makeProvenance(definition, ctx, { dataset: "catchment-planning/classifications.csv", basis: "unavailable" }) };
        }
        if (/^\s*<(!doctype|html)/i.test(text)) throw new IntegrationHttpError("Catchment Data Explorer returned HTML instead of CSV", status, url, text.slice(0, 500));
        const all = classificationRows(text, { waterBodyId: params.waterBodyId as string | undefined, latestOnly: !params.allYears });
        const headline = all.filter((r) => /overall|ecological|chemical/i.test(r.classification_item) && (!r.classification_level || /overall|ecological|chemical|status/i.test(r.classification_level)));
        const rows = (headline.length ? headline : all).slice(0, 500);
        const bodies = new Set(rows.map((r) => r.water_body_id));
        const overall = rows.filter((r) => /overall/i.test(r.classification_item));
        const counts = new Map<string, number>();
        for (const r of overall) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
        return {
          summary: rows.length ? `${bodies.size} water bodies in operational catchment ${cid}; ${rows.length} classification rows${overall.length ? ` (overall status: ${Array.from(counts.entries()).map(([s, n]) => `${n} ${s}`).join(", ")})` : ""}.` : `No classification rows found for catchment ${cid}${params.waterBodyId ? ` / ${params.waterBodyId}` : ""}.`,
          columns: CLASS_COLUMNS,
          rows,
          raw: { source: url, rowsParsed: all.length },
          provenance: makeProvenance(definition, ctx, { dataset: "catchment-planning/classifications.csv", basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["WFD classification describes the water body's status under the River Basin Management Plan; it is not a measure of a site's impact."],
          links: [{ label: `Operational catchment ${cid}`, url: `${BASE}/OperationalCatchment/${cid}` }],
        };
      },
    },
    {
      id: "links",
      label: "Find a water body for a location (manual)",
      description: "Links to the Catchment Data Explorer map to identify the water body and operational catchment for a location, since a point query is not available.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        return {
          summary: "Use the Catchment Data Explorer map to find the water body id and operational catchment id for the site, then run the id-based operations.",
          rows: [],
          provenance: makeProvenance(definition, ctx, { dataset: "catchment-planning", basis: "not_applicable" }),
          links: [
            { label: "Catchment Data Explorer", url: BASE },
            { label: "Catchment Data API reference", url: `${BASE}/api/docs` },
            { label: "England water bodies GeoJSON (bulk)", url: `${BASE}/England.geojson` },
          ],
        };
      },
    },
  ],
});
