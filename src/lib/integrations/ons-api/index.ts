import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth } from "../framework";
import { parseDimensionLines } from "../nomis";

/**
 * ONS Beta API (api.beta.ons.gov.uk/v1): dataset catalogue and
 * observation extraction for "Customise my data" and Census 2021 datasets.
 *
 * Built from ONSdigital/dp-developer-site documentation; no live call has
 * been made from this codebase.
 */

export const BASE = "https://api.beta.ons.gov.uk/v1";

interface Link {
  href?: string;
  id?: string;
}
interface DatasetItem {
  id: string;
  title?: string;
  description?: string;
  type?: string;
  release_frequency?: string;
  next_release?: string;
  unit_of_measure?: string;
  keywords?: string[];
  links?: { latest_version?: Link; editions?: Link; self?: Link };
  contacts?: { name?: string; email?: string }[];
}
interface DatasetList {
  items?: DatasetItem[];
  count?: number;
  total_count?: number;
  limit?: number;
  offset?: number;
}
interface Observation {
  observation?: string;
  dimensions?: Record<string, { id?: string; label?: string; href?: string }>;
  metadata?: Record<string, string>;
}
interface Observations {
  observations?: Observation[];
  total_observations?: number;
  unit_of_measure?: string;
  dimensions?: Record<string, { option?: { id?: string; href?: string } }>;
  limit?: number;
  offset?: number;
}

/** "/datasets/{id}/editions/{edition}/versions/{n}" -> {edition, version}. */
export function parseVersionHref(href?: string): { edition?: string; version?: string } {
  const m = href?.match(/\/editions\/([^/]+)\/versions\/([^/?]+)/);
  return m ? { edition: m[1], version: m[2] } : {};
}

function datasetRow(d: DatasetItem) {
  const v = parseVersionHref(d.links?.latest_version?.href);
  return {
    dataset_id: d.id,
    title: d.title ?? null,
    type: d.type ?? null,
    latest_edition: v.edition ?? null,
    latest_version: v.version ?? d.links?.latest_version?.id ?? null,
    release_frequency: d.release_frequency ?? null,
    next_release: d.next_release ?? null,
    unit: d.unit_of_measure ?? null,
    description: (d.description ?? "").slice(0, 300) || null,
  };
}

export const definition = defineIntegration({
  id: "ons-api",
  name: "ONS Beta API",
  group: "company",
  access: "open",
  territory: "UK",
  description: "Office for National Statistics datasets by API: catalogue search and observation extraction with free-form dimension filters (time, geography and dataset-specific dimensions).",
  docsUrl: "https://developer.ons.gov.uk/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Office for National Statistics.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "No key. The observations endpoint needs one option per dimension (or '*' for exactly one dimension, capped at 10,000 observations); dimension names differ per dataset, so read the dataset entry first (dataset detail returns the latest edition and version).",
    "Census 2021 datasets use /datasets/{id}/editions/{edition}/versions/{version}/json with area-type filters rather than the observations route; this connector covers the observations route.",
    "The English Indices of Deprivation (IMD 2019) are a separate MHCLG download, not on this API.",
    "The 'time' dimension uses labels (e.g. 'Mar-18', '2021'), not ids.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "datasets", { limit: 1 })),
  operations: [
    {
      id: "datasets",
      label: "List or search datasets",
      description: "The dataset catalogue, optionally filtered by words in the title or description.",
      params: [
        { name: "search", label: "Title contains", type: "string", placeholder: "travel to work" },
        { name: "limit", label: "Catalogue page size", type: "integer", default: 100, min: 1, max: 1000 },
        { name: "offset", label: "Offset", type: "integer", default: 0, min: 0 },
      ],
      async run(params, ctx) {
        const url = buildUrl(BASE, "datasets", { limit: params.limit as number, offset: params.offset as number });
        const { data } = await fetchJson<DatasetList>(ctx, url);
        const q = String(params.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const items = (data.items ?? []).filter((d) => !q.length || q.every((t) => `${d.title ?? ""} ${d.description ?? ""} ${(d.keywords ?? []).join(" ")}`.toLowerCase().includes(t)));
        const rows = items.slice(0, 200).map(datasetRow);
        return {
          summary: `${rows.length} of ${data.items?.length ?? 0} datasets on this page${q.length ? ` match "${params.search}"` : ""} (${data.total_count ?? "?"} in the catalogue).`,
          columns: ["dataset_id", "title", "type", "latest_edition", "latest_version", "release_frequency", "next_release", "unit", "description"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "datasets", basis: rows.length ? "measured" : "unavailable" }),
          warnings: q.length && (data.total_count ?? 0) > (data.items?.length ?? 0) ? ["The catalogue is paginated; the search covered one page. Increase the limit or offset to search the rest."] : undefined,
        };
      },
    },
    {
      id: "dataset",
      label: "Dataset detail",
      description: "Title, latest edition and version, release cadence and contacts for one dataset.",
      params: [{ name: "dataset_id", label: "Dataset id", type: "string", required: true, placeholder: "cpih01" }],
      async run(params, ctx) {
        const { data, status } = await fetchJson<DatasetItem>(ctx, buildUrl(BASE, `datasets/${encodeURIComponent(String(params.dataset_id))}`), {}, { acceptStatuses: [404] });
        if (status === 404 || !data?.id) return { summary: `Dataset ${params.dataset_id} not found.`, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "datasets", basis: "unavailable" }) };
        const row = datasetRow(data);
        return {
          summary: `${row.title ?? row.dataset_id}: latest edition ${row.latest_edition ?? "n/a"} version ${row.latest_version ?? "n/a"}; next release ${row.next_release ?? "not stated"}.`,
          columns: Object.keys(row),
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: `datasets/${data.id}`, basis: "measured" }),
        };
      },
    },
    {
      id: "observations",
      label: "Observations for a dataset",
      description: "Values for one dataset edition and version, filtered by one option per dimension (one dimension may be '*').",
      params: [
        { name: "dataset_id", label: "Dataset id", type: "string", required: true, placeholder: "cpih01" },
        { name: "edition", label: "Edition", type: "string", required: true, placeholder: "time-series" },
        { name: "version", label: "Version", type: "string", required: true, placeholder: "6" },
        { name: "dimensions", label: "Dimension filters", type: "text", required: true, placeholder: "time=*\ngeography=K02000001\naggregate=cpih1dim1A0", help: "One key=value per line. Use * for one dimension to return all its values." },
      ],
      async run(params, ctx) {
        const dims = parseDimensionLines(params.dimensions);
        if (Object.keys(dims).length === 0) throw new Error("At least one dimension filter (key=value) is required.");
        const wildcards = Object.values(dims).filter((v) => v === "*").length;
        if (wildcards > 1) throw new Error("Only one dimension may be '*'.");
        const url = buildUrl(BASE, `datasets/${encodeURIComponent(String(params.dataset_id))}/editions/${encodeURIComponent(String(params.edition))}/versions/${encodeURIComponent(String(params.version))}/observations`, dims);
        const { data, status } = await fetchJson<Observations>(ctx, url, {}, { acceptStatuses: [404], timeoutMs: 45_000 });
        if (status === 404) return { summary: `No observations: dataset, edition, version or a dimension option was not found (${url}).`, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: String(params.dataset_id), basis: "unavailable" }) };
        const rows = (data.observations ?? []).slice(0, 10_000).map((o) => {
          const row: Record<string, unknown> = { value: o.observation === undefined || o.observation === "" ? null : Number(o.observation) };
          for (const [k, v] of Object.entries(o.dimensions ?? {})) {
            row[k] = v.label ?? v.id ?? null;
            row[`${k}_id`] = v.id ?? null;
          }
          for (const [k, v] of Object.entries(o.metadata ?? {})) row[`meta_${k}`] = v;
          return row;
        });
        const fixed = Object.entries(data.dimensions ?? {}).map(([k, v]) => `${k}=${v.option?.id ?? "?"}`).join(", ");
        return {
          summary: `${data.total_observations ?? rows.length} observation(s) from ${params.dataset_id} ${params.edition} v${params.version}${data.unit_of_measure ? ` (${data.unit_of_measure})` : ""}${fixed ? `; fixed dimensions ${fixed}` : ""}.`,
          columns: rows.length ? Object.keys(rows[0]) : ["value"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: `${params.dataset_id}/${params.edition}/${params.version}`, basis: rows.length ? "measured" : "unavailable", version: `edition ${params.edition} version ${params.version}` }),
        };
      },
    },
  ],
});
