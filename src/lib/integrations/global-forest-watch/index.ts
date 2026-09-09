import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type EnvLike } from "../framework";

/**
 * Global Forest Watch Data API (data-api.globalforestwatch.org).
 *
 * Minimal catalogue connector built from the API's ReDoc documentation and
 * the wri/gfw-data-api source (Dataset model: dataset, is_downloadable,
 * metadata, versions[]) plus open-source clients that send x-api-key; no
 * live call has been made from this codebase.
 */

export const BASE = "https://data-api.globalforestwatch.org";

function headers(env: EnvLike): Record<string, string> {
  const key = env.GFW_API_KEY?.trim();
  if (!key) throw new Error("GFW_API_KEY is not set. Create an account and API key per https://data-api.globalforestwatch.org/ (POST /auth/sign-up, then /auth/apikey).");
  return { "x-api-key": key, accept: "application/json" };
}

interface Metadata {
  title?: string;
  subtitle?: string;
  source?: string;
  license?: string;
  data_language?: string;
  overview?: string;
  citation?: string;
  resolution?: string;
  geographic_coverage?: string;
  update_frequency?: string;
  content_date?: string;
  last_update?: string;
}
interface Dataset {
  dataset: string;
  is_downloadable?: boolean;
  metadata?: Metadata | null;
  versions?: string[];
  created_on?: string;
  updated_on?: string;
}
interface Envelope<T> {
  data: T;
  status?: string;
  links?: { next?: string };
  meta?: { total_items?: number; total_pages?: number; size?: number };
}

export function datasetRow(d: Dataset) {
  const m = d.metadata ?? {};
  return {
    dataset: d.dataset,
    title: m.title ?? null,
    latest_version: d.versions?.length ? [...d.versions].sort().at(-1) ?? null : null,
    versions: d.versions?.length ?? 0,
    licence: m.license ?? null,
    source: m.source ?? null,
    coverage: m.geographic_coverage ?? null,
    resolution: m.resolution ?? null,
    update_frequency: m.update_frequency ?? null,
    downloadable: d.is_downloadable ?? null,
    updated: d.updated_on ?? m.last_update ?? null,
  };
}

const COLUMNS = ["dataset", "title", "latest_version", "versions", "licence", "source", "coverage", "resolution", "update_frequency", "downloadable", "updated"];

export const definition = defineIntegration({
  id: "global-forest-watch",
  name: "Global Forest Watch Data API",
  group: "nature",
  access: "open_key",
  territory: "Global",
  description: "Catalogue of Global Forest Watch datasets (tree cover loss, integrated deforestation alerts, primary forest, GADM boundaries) with versions and licences; the first step towards deforestation-free supply chain checks.",
  docsUrl: "https://data-api.globalforestwatch.org/",
  termsUrl: "https://www.globalforestwatch.org/terms/",
  attribution: "Data from Global Forest Watch (World Resources Institute) Data API; each dataset carries its own licence and citation in its metadata.",
  licence: "restricted",
  envVars: [{ name: "GFW_API_KEY", required: true, description: "API key created via the GFW Data API auth endpoints (free); sent as x-api-key. Keys are tied to an allowed origin/domain." }],
  status: "built_unverified",
  notes: [
    "Only the dataset catalogue (GET /datasets, GET /dataset/{name}) is implemented. Spatial queries (POST /dataset/{name}/{version}/query with an SQL string and a geostore or geometry) and /geostore creation are not yet built because their request shapes could not be confirmed offline.",
    "API keys are issued per application with an allowed domain; some deployments also require an Origin header matching that domain.",
    "Dataset licences vary (CC BY 4.0 for most WRI datasets; others restricted); read metadata.license before reuse.",
    "Alerts (GLAD, RADD, integrated) are satellite-detected disturbance, not confirmed deforestation; ground truth or supplier evidence is still needed for EUDR-style claims.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "datasets", { size: 1 }), (env) => ({ headers: headers(env) })),
  operations: [
    {
      id: "datasets",
      label: "List or search datasets",
      description: "The GFW dataset catalogue, optionally filtered by words in the dataset name or title.",
      params: [
        { name: "search", label: "Name or title contains", type: "string", placeholder: "tree cover loss" },
        { name: "page_size", label: "Page size", type: "integer", default: 100, min: 1, max: 1000 },
        { name: "page", label: "Page", type: "integer", default: 1, min: 1 },
      ],
      async run(params, ctx) {
        const url = buildUrl(BASE, "datasets", { "page[size]": params.page_size as number, "page[number]": params.page as number });
        const { data } = await fetchJson<Envelope<Dataset[]>>(ctx, url, { headers: headers(ctx.env) });
        const q = String(params.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const all = Array.isArray(data.data) ? data.data : [];
        const rows = all.filter((d) => !q.length || q.every((t) => `${d.dataset} ${d.metadata?.title ?? ""}`.toLowerCase().includes(t))).map(datasetRow);
        return {
          summary: `${rows.length} of ${all.length} datasets on page ${params.page}${q.length ? ` match "${params.search}"` : ""}${data.meta?.total_items ? ` (${data.meta.total_items} in the catalogue)` : ""}.`,
          columns: COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "datasets", basis: rows.length ? "measured" : "unavailable" }),
          warnings: q.length && data.links?.next ? ["The catalogue is paginated; the search covered one page."] : undefined,
        };
      },
    },
    {
      id: "dataset",
      label: "Dataset detail",
      description: "Metadata, licence, citation and versions for one dataset.",
      params: [{ name: "dataset", label: "Dataset name", type: "string", required: true, placeholder: "umd_tree_cover_loss" }],
      async run(params, ctx) {
        const name = String(params.dataset).trim();
        const { data, status } = await fetchJson<Envelope<Dataset>>(ctx, buildUrl(BASE, `dataset/${encodeURIComponent(name)}`), { headers: headers(ctx.env) }, { acceptStatuses: [404] });
        if (status === 404 || !data?.data?.dataset) return { summary: `Dataset ${name} not found.`, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "dataset", basis: "unavailable" }) };
        const row = { ...datasetRow(data.data), citation: data.data.metadata?.citation ?? null, overview: (data.data.metadata?.overview ?? "").slice(0, 500) || null };
        return {
          summary: `${row.title ?? row.dataset}: ${row.versions} version(s), latest ${row.latest_version ?? "n/a"}; licence ${row.licence ?? "not stated"}.`,
          columns: Object.keys(row),
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: `dataset/${name}`, basis: "measured", version: row.latest_version ?? undefined }),
        };
      },
    },
  ],
});
