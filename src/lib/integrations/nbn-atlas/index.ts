import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type EnvLike } from "../framework";

/**
 * NBN Atlas occurrence web service (records-ws.nbnatlas.org), an Atlas of
 * Living Australia (biocache) deployment.
 *
 * Built from the NBN Atlas web-service documentation and open-source
 * clients (lat/lon/radius, fq, facets, pageSize; species_list_uid filter);
 * no live call has been made from this codebase.
 */

export const BASE = "https://records-ws.nbnatlas.org";

function headers(env: EnvLike): Record<string, string> {
  const key = env.NBN_ATLAS_API_KEY?.trim();
  return key ? { "x-api-key": key } : {};
}

interface Occurrence {
  uuid?: string;
  scientificName?: string;
  vernacularName?: string;
  taxonRank?: string;
  kingdom?: string;
  classs?: string;
  family?: string;
  year?: number;
  eventDate?: string | number;
  dataResourceName?: string;
  decimalLatitude?: number;
  decimalLongitude?: number;
  coordinateUncertaintyInMeters?: number;
  basisOfRecord?: string;
  license?: string;
  licence?: string;
  gridReference?: string;
  speciesGuid?: string;
  taxonConceptID?: string;
}
interface FacetResult {
  fieldName?: string;
  fieldResult?: { label?: string; i18nCode?: string; count?: number; fq?: string }[];
}
interface SearchResponse {
  totalRecords?: number;
  occurrences?: Occurrence[];
  facetResults?: FacetResult[];
  pageSize?: number;
  startIndex?: number;
}

/** names_and_lsid facet labels are pipe-delimited: scientific name|lsid|vernacular|kingdom|family. */
export function parseNamesFacet(label: string): { scientific: string; lsid: string | null; vernacular: string | null; kingdom: string | null; family: string | null } {
  const parts = label.split("|");
  return { scientific: parts[0] ?? label, lsid: parts[1] || null, vernacular: parts[2] || null, kingdom: parts[3] || null, family: parts[4] || null };
}

export function buildFq(opts: { fromYear?: number; speciesListUid?: string; extra?: string }): string[] {
  const fq: string[] = ["-occurrence_status:absent"];
  if (opts.fromYear) fq.push(`year:[${opts.fromYear} TO *]`);
  if (opts.speciesListUid) fq.push(`species_list_uid:${opts.speciesListUid.trim()}`);
  if (opts.extra?.trim()) fq.push(opts.extra.trim());
  return fq;
}

const WARNINGS = [
  "No records is not evidence of no ecological risk: recording effort is uneven and many sites have never been surveyed. A desktop search does not replace an ecological survey.",
  "Licences vary per dataset (CC0, CC BY, CC BY-NC and others); check the licence column before reusing records commercially.",
  "Locations of sensitive species are generalised (blurred) by data providers, so precise distance to a site cannot be inferred for those records.",
];

const OCC_COLUMNS = ["scientific_name", "common_name", "kingdom", "family", "year", "date", "latitude", "longitude", "uncertainty_m", "grid_reference", "basis", "dataset", "licence"];

export const definition = defineIntegration({
  id: "nbn-atlas",
  name: "NBN Atlas",
  group: "nature",
  access: "open",
  territory: "UK",
  description: "UK species occurrence records aggregated by the National Biodiversity Network: records near a point with per-species counts, optionally restricted to a species list (for example designated or priority species).",
  docsUrl: "https://api.nbnatlas.org/",
  termsUrl: "https://nbnatlas.org/help/nbn-atlas-terms-of-use/",
  attribution: "Species records from the NBN Atlas (https://nbnatlas.org), contributed by many data providers under the licence stated for each dataset.",
  licence: "mixed",
  envVars: [{ name: "NBN_ATLAS_API_KEY", required: false, description: "Optional API key from NBN Atlas for higher limits; sent as x-api-key (header name not confirmed against the live service)." }],
  status: "built_unverified",
  notes: [
    "Radius is in kilometres around the point; results are paged (pageSize up to 100 here) and facets give counts per species across all matching records, not just the page.",
    "The species facet uses the names_and_lsid field (label 'scientific|lsid|common|kingdom|family'); if the service returns a different facet format the raw facetResults are still available.",
    "Designated or protected species are filtered with fq=species_list_uid:<uid>, where the uid is an NBN Atlas species list (lists.nbnatlas.org), for example a country's protected species list; look the uid up on the lists site, it is not hard-coded here.",
    "Commercial use of some datasets requires the provider's permission; the NBN Atlas terms of use apply.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "occurrences/search", { q: "*:*", pageSize: 0 })),
  operations: [
    {
      id: "records_near",
      label: "Species records near a point",
      description: "Occurrence records within a radius, with a per-species count summary from facets.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
        { name: "radius_km", label: "Radius (km)", type: "number", default: 1, min: 0.1, max: 10 },
        { name: "from_year", label: "Records from year", type: "integer", default: 2016, min: 1600, max: 2100, help: "Older records may reflect habitat that no longer exists." },
        { name: "species_list_uid", label: "Species list uid (optional)", type: "string", placeholder: "dr1940", help: "NBN Atlas species list id (e.g. a designated / priority species list) to restrict records." },
        { name: "page_size", label: "Records to return", type: "integer", default: 50, min: 0, max: 100 },
      ],
      async run(params, ctx) {
        const fq = buildFq({ fromYear: params.from_year as number | undefined, speciesListUid: params.species_list_uid as string | undefined });
        const base = buildUrl(BASE, "occurrences/search", {
          q: "*:*",
          lat: params.latitude as number,
          lon: params.longitude as number,
          radius: params.radius_km as number,
          pageSize: params.page_size as number,
          facets: "names_and_lsid",
          flimit: 200,
          fsort: "count",
          sort: "year",
          dir: "desc",
        });
        const url = `${base}&${fq.map((f) => `fq=${encodeURIComponent(f)}`).join("&")}`;
        const { data } = await fetchJson<SearchResponse>(ctx, url, { headers: headers(ctx.env) }, { timeoutMs: 45_000 });
        const total = data.totalRecords ?? 0;
        const facet = (data.facetResults ?? []).find((f) => f.fieldName === "names_and_lsid") ?? data.facetResults?.[0];
        const species = (facet?.fieldResult ?? []).map((f) => ({ ...parseNamesFacet(f.label ?? ""), count: f.count ?? 0 }));
        const records = (data.occurrences ?? []).map((o) => ({
          scientific_name: o.scientificName ?? null,
          common_name: o.vernacularName ?? null,
          kingdom: o.kingdom ?? null,
          family: o.family ?? null,
          year: o.year ?? null,
          date: typeof o.eventDate === "number" ? new Date(o.eventDate).toISOString().slice(0, 10) : (o.eventDate ?? null),
          latitude: o.decimalLatitude ?? null,
          longitude: o.decimalLongitude ?? null,
          uncertainty_m: o.coordinateUncertaintyInMeters ?? null,
          grid_reference: o.gridReference ?? null,
          basis: o.basisOfRecord ?? null,
          dataset: o.dataResourceName ?? null,
          licence: o.license ?? o.licence ?? null,
        }));
        const topSpecies = species.slice(0, 5).map((s) => `${s.vernacular ?? s.scientific} (${s.count})`).join(", ");
        return {
          summary: total
            ? `${total.toLocaleString("en-GB")} records of ${species.length} taxa within ${params.radius_km} km since ${params.from_year ?? "any year"}${params.species_list_uid ? ` on list ${params.species_list_uid}` : ""}. Most recorded: ${topSpecies || "n/a"}.`
            : `No NBN Atlas records within ${params.radius_km} km of ${params.latitude}, ${params.longitude} since ${params.from_year ?? "any year"}${params.species_list_uid ? ` on list ${params.species_list_uid}` : ""}. This does not mean no species are present.`,
          columns: ["scientific_name", "common_name", "kingdom", "family", "records"],
          rows: species.map((s) => ({ scientific_name: s.scientific, common_name: s.vernacular, kingdom: s.kingdom, family: s.family, records: s.count })),
          raw: { totalRecords: total, speciesFacet: species, records, recordColumns: OCC_COLUMNS, facetResults: data.facetResults },
          provenance: makeProvenance(definition, ctx, { dataset: "occurrences/search", basis: total ? "measured" : "unavailable" }),
          warnings: WARNINGS,
        };
      },
    },
  ],
});
