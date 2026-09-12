import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth } from "../framework";

/**
 * Resource Watch API (api.resourcewatch.org/v1), the WRI dataset catalogue
 * also used by Global Forest Watch's front end.
 *
 * Built from the RW API documentation (https://resource-watch.github.io/doc-api/)
 * and open-source usage (?search=&page[size]=; JSON:API data[] with
 * attributes); no live call has been made from this codebase.
 */

export const BASE = "https://api.resourcewatch.org/v1";

interface Dataset {
  id: string;
  type?: string;
  attributes?: {
    name?: string;
    slug?: string;
    description?: string;
    provider?: string;
    connectorType?: string;
    published?: boolean;
    env?: string;
    application?: string[];
    updatedAt?: string;
    createdAt?: string;
    metadata?: { attributes?: { name?: string; description?: string; source?: string; license?: string; info?: { license?: string; sources?: { ["source-name"]?: string }[] } } }[];
  };
}
interface Envelope {
  data?: Dataset[];
  links?: { next?: string; last?: string };
  meta?: { ["total-pages"]?: number; ["total-items"]?: number; size?: number };
}

export function datasetRow(d: Dataset) {
  const a = d.attributes ?? {};
  const m = a.metadata?.[0]?.attributes;
  return {
    id: d.id,
    name: a.name ?? null,
    slug: a.slug ?? null,
    provider: a.provider ?? null,
    connector: a.connectorType ?? null,
    published: a.published ?? null,
    applications: (a.application ?? []).join(", ") || null,
    licence: m?.license ?? m?.info?.license ?? null,
    source: m?.source ?? m?.info?.sources?.map((s) => s["source-name"]).filter(Boolean).join("; ") ?? null,
    updated: a.updatedAt ?? null,
    description: (m?.description ?? a.description ?? "").slice(0, 300) || null,
  };
}

const COLUMNS = ["id", "name", "slug", "provider", "connector", "published", "applications", "licence", "source", "updated", "description"];

export const definition = defineIntegration({
  id: "resource-watch",
  name: "Resource Watch API",
  group: "nature",
  access: "open",
  territory: "Global",
  description: "World Resources Institute's open catalogue of environmental datasets (water risk, land cover, biodiversity, climate) with provider, licence and source metadata, searchable by keyword.",
  docsUrl: "https://resource-watch.github.io/doc-api/",
  termsUrl: "https://resourcewatch.org/terms-of-service",
  attribution: "Dataset catalogue from Resource Watch (World Resources Institute); each dataset carries its own licence and source attribution in its metadata.",
  licence: "restricted",
  envVars: [],
  status: "built_unverified",
  notes: [
    "No key for read access. Results are JSON:API documents (data[].attributes); metadata is included with includes=metadata and can be in several languages (the first entry is used).",
    "The catalogue is the index, not the data: each dataset points to a provider (Carto, GEE, feature service) that is queried separately via /v1/query/{dataset} with SQL, which is not built here.",
    "Filter by application (rw, gfw, aqueduct) to narrow to a product's curated datasets; default is all published datasets.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "dataset", { "page[size]": 1 })),
  operations: [
    {
      id: "search",
      label: "Search datasets",
      description: "Datasets whose name or metadata matches the search text.",
      params: [
        { name: "search", label: "Search text", type: "string", required: true, placeholder: "water stress" },
        { name: "application", label: "Application", type: "select", default: "", options: [{ value: "", label: "Any" }, { value: "rw", label: "Resource Watch" }, { value: "gfw", label: "Global Forest Watch" }, { value: "aqueduct", label: "Aqueduct (water risk)" }] },
        { name: "page_size", label: "Page size", type: "integer", default: 50, min: 1, max: 100 },
      ],
      async run(params, ctx) {
        const url = buildUrl(BASE, "dataset", {
          search: String(params.search),
          application: params.application ? String(params.application) : undefined,
          published: true,
          includes: "metadata",
          "page[size]": params.page_size as number,
        });
        const { data } = await fetchJson<Envelope>(ctx, url);
        const rows = (data.data ?? []).map(datasetRow);
        return {
          summary: `${rows.length} datasets match "${params.search}"${params.application ? ` in ${params.application}` : ""}${data.meta?.["total-items"] !== undefined ? ` (${data.meta["total-items"]} in total)` : ""}.`,
          columns: COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "dataset", basis: rows.length ? "measured" : "unavailable" }),
        };
      },
    },
  ],
});
