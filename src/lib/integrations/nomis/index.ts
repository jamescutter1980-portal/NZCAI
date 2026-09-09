import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth } from "../framework";

/**
 * ONS Nomis RESTful API v01 (labour market and census statistics).
 *
 * Built from https://www.nomisweb.co.uk/api/v01/about as mirrored by
 * open-source wrappers (ouseful-datasupply/nomisweb, ropensci/nomisr) and
 * from Census 2021 pipelines that use the same dataset ids; no live call
 * has been made from this codebase.
 *
 * Confirmed ids: NM_2078_1 = Census 2021 TS061 Method used to travel to
 * work (dimension c2021_ttwmeth_12), as used by traffordDataLab/open_data
 * and other open-source pipelines.
 */

export const BASE = "https://www.nomisweb.co.uk/api/v01";
export const TS061_DATASET = "NM_2078_1";
export const TS061_DIMENSION = "c2021_ttwmeth_12";

interface SdmxText {
  value?: string;
}
interface KeyFamily {
  id: string;
  agencyid?: string;
  name?: SdmxText;
  description?: SdmxText;
  annotations?: { annotation?: { annotationtitle?: string; annotationtext?: string }[] };
  components?: { dimension?: { codelist?: string; conceptref?: string }[] };
}
interface DatasetDefs {
  structure?: { keyfamilies?: { keyfamily?: KeyFamily[] } | null };
}
interface Codelists {
  structure?: { codelists?: { codelist?: { id?: string; name?: SdmxText; code?: { value?: string; description?: SdmxText; annotations?: { annotation?: { annotationtitle?: string; annotationtext?: string }[] } }[] }[] } | null };
}
interface ObsCell {
  value?: string | number;
  description?: string;
  geogcode?: string;
}
interface DataJson {
  obs?: Record<string, ObsCell | string | number | undefined>[];
}

/** Parses "key=value" lines into extra query parameters (dimension filters). */
export function parseDimensionLines(text: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text ?? "").split(/\r?\n|;/)) {
    const m = line.trim().match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

const RESERVED = new Set(["geography", "time", "date", "measures", "select", "uid"]);

export function obsToRow(obs: Record<string, ObsCell | string | number | undefined>) {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obs)) {
    if (v === undefined) continue;
    if (typeof v === "object") {
      if (k === "obs_value") row.value = v.value === undefined || v.value === "" ? null : Number(v.value);
      else if (k === "geography") {
        row.geography = v.description ?? null;
        row.geography_code = v.geogcode ?? v.value ?? null;
      } else if (k === "obs_status" || k === "obs_conf") row[k] = v.description ?? v.value ?? null;
      else row[k] = v.description ?? v.value ?? null;
    } else row[k] = v;
  }
  return row;
}

export const definition = defineIntegration({
  id: "nomis",
  name: "Nomis (ONS labour market and census)",
  group: "company",
  access: "open",
  territory: "UK",
  description: "Official labour market statistics and Census 2021 tables by area: dataset discovery, geography code lookup, and data extraction for a dataset and area. Includes a shortcut for Census 2021 travel-to-work mode (TS061) for commuting baselines.",
  docsUrl: "https://www.nomisweb.co.uk/api/v01/about",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Office for National Statistics via Nomis.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "No key needed; anonymous calls are limited to 25,000 cells per request and Nomis asks for a UID (free registration) for heavier use.",
    "Geography codes are Nomis numeric ids (e.g. 2092957697 = UK), not GSS codes; use the geography lookup with a TYPE code (TYPE464 or TYPE150 local authorities, TYPE480 regions, TYPE499 countries; census datasets use their own TYPE numbers) to find them. The lookup can also take a postcode helper form on some datasets; not exposed here.",
    "Dataset ids and dimension names differ per dataset; use the dataset search to find the id, then pass dimension filters as key=value lines. measures=20100 returns values, 20301 percentages, on most census tables.",
    "TS061 (NM_2078_1) reflects Census Day 21 March 2021 during a national lockdown, so travel-to-work shares are not comparable with 2011 and understate commuting by public transport.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "dataset/def.sdmx.json", { search: "name:*claimant*" })),
  operations: [
    {
      id: "search_datasets",
      label: "Search datasets",
      description: "Finds Nomis datasets whose name contains the search term.",
      params: [{ name: "term", label: "Search term", type: "string", required: true, placeholder: "travel to work" }],
      async run(params, ctx) {
        const term = String(params.term).trim().replace(/\s+/g, "*");
        const url = buildUrl(BASE, "dataset/def.sdmx.json", { search: `name:*${term}*` });
        const { data } = await fetchJson<DatasetDefs>(ctx, url);
        const families = data.structure?.keyfamilies?.keyfamily ?? [];
        const rows = families.slice(0, 100).map((kf) => ({
          dataset_id: kf.id,
          name: kf.name?.value ?? null,
          description: (kf.description?.value ?? kf.annotations?.annotation?.find((a) => a.annotationtitle === "MetadataText0")?.annotationtext ?? "").slice(0, 300) || null,
          dimensions: (kf.components?.dimension ?? []).map((d) => d.conceptref ?? d.codelist).filter(Boolean).join(", "),
          source: kf.annotations?.annotation?.find((a) => a.annotationtitle === "contenttype/sources")?.annotationtext ?? null,
        }));
        return {
          summary: `${families.length} datasets match "${params.term}".`,
          columns: ["dataset_id", "name", "description", "dimensions", "source"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "dataset/def.sdmx", basis: rows.length ? "measured" : "unavailable" }),
        };
      },
    },
    {
      id: "geography_codes",
      label: "Find geography codes",
      description: "Lists the Nomis geography codes of a type (e.g. local authorities) available for a dataset, filtered by name.",
      params: [
        { name: "dataset_id", label: "Dataset id", type: "string", required: true, placeholder: TS061_DATASET },
        { name: "type", label: "Geography TYPE code", type: "string", required: true, default: "TYPE150", placeholder: "TYPE150", help: "TYPE150 = 2021 local authority districts on census tables; TYPE464 on many labour-market tables; TYPE480 regions; TYPE499 countries." },
        { name: "search", label: "Name contains", type: "string", placeholder: "Westminster" },
      ],
      async run(params, ctx) {
        const type = String(params.type).toUpperCase().replace(/[^A-Z0-9]/g, "");
        const url = buildUrl(BASE, `dataset/${encodeURIComponent(String(params.dataset_id))}/geography/${type}.def.sdmx.json`, { search: params.search ? `*${String(params.search)}*` : undefined });
        const { data } = await fetchJson<Codelists>(ctx, url);
        const codes = (data.structure?.codelists?.codelist ?? []).flatMap((cl) => cl.code ?? []);
        const q = params.search ? String(params.search).toLowerCase() : "";
        const rows = codes
          .filter((c) => !q || (c.description?.value ?? "").toLowerCase().includes(q))
          .slice(0, 100)
          .map((c) => ({
            nomis_code: c.value ?? null,
            name: c.description?.value ?? null,
            gss_code: c.annotations?.annotation?.find((a) => /gss|geogcode|code/i.test(a.annotationtitle ?? ""))?.annotationtext ?? null,
          }));
        return {
          summary: `${rows.length} ${type} geographies${q ? ` matching "${params.search}"` : ""} for ${params.dataset_id}${codes.length > rows.length ? ` (of ${codes.length})` : ""}.`,
          columns: ["nomis_code", "name", "gss_code"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: `dataset/${params.dataset_id}/geography/${type}`, basis: rows.length ? "measured" : "unavailable" }),
        };
      },
    },
    {
      id: "data",
      label: "Fetch data for a dataset and geography",
      description: "Observations for one dataset and one or more Nomis geography codes, with optional dimension filters.",
      params: [
        { name: "dataset_id", label: "Dataset id", type: "string", required: true, placeholder: TS061_DATASET },
        { name: "geography", label: "Nomis geography code(s)", type: "string", required: true, placeholder: "645922841", help: "Comma-separated Nomis codes from the geography lookup." },
        { name: "time", label: "Time", type: "string", default: "latest", placeholder: "latest" },
        { name: "measures", label: "Measures", type: "string", default: "20100", help: "20100 value, 20301 percent (census tables)." },
        { name: "dimensions", label: "Dimension filters", type: "text", placeholder: "c2021_ttwmeth_12=0...11", help: "One key=value per line, e.g. sex=7 or item=1. Ranges use a...b." },
      ],
      async run(params, ctx) {
        const extra = parseDimensionLines(params.dimensions);
        for (const k of Object.keys(extra)) if (RESERVED.has(k)) delete extra[k];
        const url = buildUrl(BASE, `dataset/${encodeURIComponent(String(params.dataset_id))}.data.json`, {
          geography: String(params.geography).replace(/\s+/g, ""),
          time: String(params.time),
          measures: String(params.measures),
          ...extra,
        });
        const { data } = await fetchJson<DataJson>(ctx, url, {}, { timeoutMs: 45_000 });
        const rows = (data.obs ?? []).slice(0, 5000).map(obsToRow);
        const columns = rows.length ? Object.keys(rows[0]) : ["geography", "geography_code", "value"];
        return {
          summary: `${data.obs?.length ?? 0} observations from ${params.dataset_id} for geography ${params.geography} (${params.time}).`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: String(params.dataset_id), basis: rows.length ? "measured" : "unavailable" }),
        };
      },
    },
    {
      id: "travel_to_work",
      label: "Census 2021 travel to work mode (TS061) for an area",
      description: "Share of employed residents by usual travel-to-work mode for a local authority or other area, as a commuting baseline.",
      params: [{ name: "geography", label: "Nomis geography code", type: "string", required: true, placeholder: "645922841", help: `Look up with the geography lookup on ${TS061_DATASET} (TYPE150 local authority districts).` }],
      async run(params, ctx) {
        const url = buildUrl(BASE, `dataset/${TS061_DATASET}.data.json`, {
          geography: String(params.geography).replace(/\s+/g, ""),
          date: "latest",
          [TS061_DIMENSION]: "0...11",
          measures: "20100,20301",
        });
        const { data } = await fetchJson<DataJson>(ctx, url, {}, { timeoutMs: 45_000 });
        const byMode = new Map<string, { mode: string; geography: string | null; count: number | null; percent: number | null }>();
        for (const obs of data.obs ?? []) {
          const row = obsToRow(obs);
          const mode = String(row[TS061_DIMENSION] ?? "unknown");
          const entry = byMode.get(mode) ?? { mode, geography: (row.geography as string | null) ?? null, count: null, percent: null };
          const measure = String(row.measures ?? "").toLowerCase();
          const value = row.value as number | null;
          if (measure.includes("percent")) entry.percent = value;
          else entry.count = value;
          byMode.set(mode, entry);
        }
        const rows = [...byMode.values()];
        const total = rows.find((r) => /^total/i.test(r.mode));
        const wfh = rows.find((r) => /home/i.test(r.mode));
        return {
          summary: rows.length
            ? `${rows[0].geography ?? params.geography}: ${total?.count?.toLocaleString("en-GB") ?? "n/a"} employed residents on Census Day 2021${wfh?.percent !== null && wfh?.percent !== undefined ? `, ${wfh.percent}% mainly working from home` : ""}. ${rows.length} mode categories.`
            : `No TS061 observations for geography ${params.geography}.`,
          columns: ["mode", "geography", "count", "percent"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: `${TS061_DATASET} (Census 2021 TS061)`, basis: rows.length ? "measured" : "unavailable", version: "Census 2021" }),
          warnings: ["Census Day (21 March 2021) fell in a national lockdown; shares understate public transport and overstate home working relative to normal years."],
        };
      },
    },
  ],
});
