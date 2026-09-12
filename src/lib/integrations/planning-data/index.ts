import { defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationContext } from "../framework";

/**
 * MHCLG Planning Data platform (planning.data.gov.uk), England.
 * Entities are queried with GET /entity.json; a point query uses
 * `latitude` and `longitude` (documented at /docs) and returns entities whose
 * geometry intersects the point. Several `dataset` parameters may be repeated
 * in one request. Built from the platform docs and the digital-land.info
 * source; not exercised live from this codebase.
 */

export const BASE = "https://www.planning.data.gov.uk";

export const CONSTRAINT_DATASETS: { id: string; label: string }[] = [
  { id: "conservation-area", label: "Conservation area" },
  { id: "article-4-direction-area", label: "Article 4 direction area" },
  { id: "listed-building", label: "Listed building" },
  { id: "listed-building-outline", label: "Listed building outline" },
  { id: "scheduled-monument", label: "Scheduled monument" },
  { id: "green-belt", label: "Green belt" },
  { id: "flood-risk-zone", label: "Flood risk zone" },
  { id: "tree-preservation-zone", label: "Tree preservation zone" },
  { id: "tree", label: "Protected tree" },
  { id: "national-park", label: "National park" },
  { id: "area-of-outstanding-natural-beauty", label: "Area of outstanding natural beauty (National Landscape)" },
  { id: "world-heritage-site", label: "World heritage site" },
  { id: "brownfield-land", label: "Brownfield land register site" },
  { id: "local-authority-district", label: "Local authority district" },
  { id: "site-of-special-scientific-interest", label: "Site of special scientific interest" },
  { id: "ancient-woodland", label: "Ancient woodland" },
];

export interface PlanningEntity {
  entity: number;
  name?: string;
  dataset: string;
  reference?: string;
  prefix?: string;
  typology?: string;
  "organisation-entity"?: string;
  "start-date"?: string;
  "end-date"?: string;
  "entry-date"?: string;
  "documentation-url"?: string;
  "listed-building-grade"?: string;
  "flood-risk-level"?: string;
  "flood-risk-type"?: string;
  "tree-preservation-order"?: string;
  notes?: string;
  geometry?: string;
  point?: string;
  [k: string]: unknown;
}

interface EntityResponse {
  count?: number;
  entities?: PlanningEntity[];
  links?: Record<string, string>;
}

const COLUMNS = ["dataset", "name", "reference", "grade_or_level", "entity", "entity_url", "organisation_entity", "start_date", "end_date", "entry_date", "documentation_url"];

export function toRow(e: PlanningEntity) {
  return {
    dataset: e.dataset,
    name: e.name || null,
    reference: e.reference || null,
    grade_or_level: e["listed-building-grade"] || e["flood-risk-level"] || null,
    entity: e.entity,
    entity_url: `${BASE}/entity/${e.entity}`,
    organisation_entity: e["organisation-entity"] || null,
    start_date: e["start-date"] || null,
    end_date: e["end-date"] || null,
    entry_date: e["entry-date"] || null,
    documentation_url: e["documentation-url"] || null,
  };
}

/** entity.json accepts repeated `dataset` parameters, which buildUrl (set-based) cannot express. */
export function entityUrl(query: Record<string, string | number | undefined>, datasets: string[]): string {
  const url = new URL(`${BASE}/entity.json`);
  for (const d of datasets) url.searchParams.append("dataset", d);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  return url.toString();
}

function parseDatasets(value: unknown): string[] {
  if (!value) return CONSTRAINT_DATASETS.map((d) => d.id);
  const ids = String(value).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const bad = ids.filter((id) => !/^[a-z0-9-]+$/.test(id));
  if (bad.length) throw new Error(`Dataset ids must be lower-case slugs: ${bad.join(", ")}`);
  return ids;
}

export const definition = defineIntegration({
  id: "planning-data",
  name: "Planning Data (planning.data.gov.uk)",
  group: "identity",
  access: "open",
  territory: "England",
  description:
    "MHCLG's national planning data platform: conservation areas, Article 4 directions, listed buildings, scheduled monuments, green belt, flood zones, tree preservation, national landscapes, brownfield sites and more, queried at a point or searched by name.",
  docsUrl: "https://www.planning.data.gov.uk/docs",
  termsUrl: "https://www.planning.data.gov.uk/about/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Planning data © Ministry of Housing, Communities and Local Government and contributing local planning authorities, Historic England, Natural England and the Environment Agency.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "England only. Completeness varies by local planning authority and dataset: national datasets (listed buildings, scheduled monuments, flood zones, SSSI, national parks, green belt) are comprehensive; LPA-supplied datasets such as conservation areas, Article 4 areas, TPOs and brownfield land are only present where the authority has published them. Absence of a hit is not evidence of no constraint.",
    "The point query uses documented `latitude`/`longitude` parameters on /entity.json and returns entities whose geometry intersects the point; a WKT `geometry` with `geometry_relation=intersects` is the alternative for polygons. Both forms come from the platform docs; not exercised live here.",
    "Planning constraints affect what fabric and plant measures are permissible (listed buildings, conservation areas, Article 4) and can support MEES exemptions where consent is refused. A hit here is a screening prompt, not a legal determination; confirm with the LPA and the NHLE entry.",
    "No key, no documented rate limit; the docs ask for polite rate limiting and recommend bulk download for screening many properties.",
  ],
  healthCheck: simpleHealth(entityUrl({ limit: 1, exclude_field: "geometry,point" }, ["national-park"])),
  operations: [
    {
      id: "constraints-at-point",
      label: "Planning and heritage constraints at a point",
      description: "Which designated areas and protected assets intersect a coordinate, across a list of datasets.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.5074" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.1278" },
        {
          name: "datasets",
          label: "Datasets",
          type: "text",
          placeholder: CONSTRAINT_DATASETS.map((d) => d.id).join(", "),
          help: `Comma-separated dataset ids. Leave blank for the standard list: ${CONSTRAINT_DATASETS.map((d) => d.id).join(", ")}.`,
        },
      ],
      async run(params, ctx: OperationContext) {
        const datasets = parseDatasets(params.datasets);
        const lat = params.latitude as number;
        const lon = params.longitude as number;
        const url = entityUrl({ latitude: lat, longitude: lon, entries: "current", limit: 100, exclude_field: "geometry,point" }, datasets);
        const { data } = await fetchJson<EntityResponse>(ctx, url);
        const rows = (data.entities ?? []).map(toRow);
        const hitDatasets = [...new Set(rows.map((r) => r.dataset))];
        const missed = datasets.filter((d) => !hitDatasets.includes(d));
        const warnings = [
          "Completeness varies by local authority and dataset; no hit does not prove no constraint.",
          "A postcode centroid can fall outside the building it stands for; use a footprint or UPRN coordinate for boundary cases (conservation area edges, flood zone edges).",
        ];
        if ((data.count ?? 0) > rows.length) warnings.push(`${data.count} entities intersect the point but only ${rows.length} were returned; narrow the dataset list.`);
        return {
          summary: rows.length
            ? `${rows.length} constraint${rows.length === 1 ? "" : "s"} at ${lat.toFixed(5)}, ${lon.toFixed(5)}: ${hitDatasets.map((d) => CONSTRAINT_DATASETS.find((c) => c.id === d)?.label ?? d).join("; ")}. No hits in ${missed.length} of ${datasets.length} datasets checked.`
            : `No entities from ${datasets.length} datasets intersect ${lat.toFixed(5)}, ${lon.toFixed(5)}.`,
          columns: COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: datasets.join(","), basis: rows.length ? "measured" : "unavailable" }),
          warnings,
          links: [{ label: "Map of planning data at this point", url: `${BASE}/map/#${lat.toFixed(5)},${lon.toFixed(5)},17` }],
        };
      },
    },
    {
      id: "search-dataset",
      label: "Search a dataset by name",
      description: "Text search within one dataset, e.g. a conservation area or listed building by name.",
      params: [
        { name: "dataset", label: "Dataset", type: "select", required: true, options: CONSTRAINT_DATASETS.map((d) => ({ value: d.id, label: d.label })) },
        { name: "query", label: "Name contains", type: "string", required: true, placeholder: "Bloomsbury" },
        { name: "limit", label: "Max results", type: "integer", default: 25, min: 1, max: 100 },
      ],
      async run(params, ctx) {
        const url = entityUrl({ q: String(params.query), entries: "current", limit: params.limit as number, exclude_field: "geometry" }, [String(params.dataset)]);
        const { data } = await fetchJson<EntityResponse>(ctx, url);
        const rows = (data.entities ?? []).map(toRow);
        return {
          summary: rows.length ? `${data.count ?? rows.length} ${params.dataset} entit${(data.count ?? rows.length) === 1 ? "y" : "ies"} match "${params.query}"; showing ${rows.length}.` : `No ${params.dataset} entities match "${params.query}".`,
          columns: COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: String(params.dataset), basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["Name search uses the platform's `q` text parameter; matching is against the entity name and may be partial."],
        };
      },
    },
    {
      id: "list-datasets",
      label: "List available datasets",
      description: "All dataset ids on the platform with entity counts, to pick ids for the constraints query.",
      params: [],
      async run(_params, ctx) {
        const { data } = await fetchJson<{ datasets?: { dataset: string; name?: string; "entity-count"?: number; typology?: string; themes?: string[]; "attribution-text"?: string }[] }>(ctx, `${BASE}/dataset.json`);
        const rows = (data.datasets ?? []).map((d) => ({ dataset: d.dataset, name: d.name ?? null, typology: d.typology ?? null, entity_count: d["entity-count"] ?? null, themes: (d.themes ?? []).join(", ") || null }));
        return {
          summary: `${rows.length} datasets published on planning.data.gov.uk.`,
          columns: ["dataset", "name", "typology", "entity_count", "themes"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "dataset", basis: "not_applicable" }),
        };
      },
    },
  ],
});
