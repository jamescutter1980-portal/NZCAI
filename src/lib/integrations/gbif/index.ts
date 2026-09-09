import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth } from "../framework";

/**
 * GBIF API v1 (Global Biodiversity Information Facility).
 *
 * Built from https://techdocs.gbif.org/en/openapi/ (occurrence search with
 * geoDistance=lat,lon,distance; species match) and open-source clients; no
 * live call has been made from this codebase.
 */

export const BASE = "https://api.gbif.org/v1";

interface Occurrence {
  key?: number;
  scientificName?: string;
  vernacularName?: string;
  kingdom?: string;
  phylum?: string;
  class?: string;
  order?: string;
  family?: string;
  species?: string;
  taxonKey?: number;
  eventDate?: string;
  year?: number;
  datasetName?: string;
  datasetKey?: string;
  decimalLatitude?: number;
  decimalLongitude?: number;
  coordinateUncertaintyInMeters?: number;
  license?: string;
  basisOfRecord?: string;
  iucnRedListCategory?: string;
}
interface Facet {
  field?: string;
  counts?: { name?: string; count?: number }[];
}
interface SearchResponse {
  offset?: number;
  limit?: number;
  endOfRecords?: boolean;
  count?: number;
  results?: Occurrence[];
  facets?: Facet[];
}
interface Match {
  usageKey?: number;
  scientificName?: string;
  canonicalName?: string;
  rank?: string;
  status?: string;
  confidence?: number;
  matchType?: string;
  kingdom?: string;
  phylum?: string;
  class?: string;
  order?: string;
  family?: string;
  genus?: string;
  species?: string;
  note?: string;
}

export const COLUMNS = ["scientific_name", "common_name", "kingdom", "class", "family", "date", "latitude", "longitude", "uncertainty_m", "basis", "dataset", "licence", "iucn_category", "gbif_key"];

export function toRow(o: Occurrence) {
  return {
    scientific_name: o.scientificName ?? null,
    common_name: o.vernacularName ?? null,
    kingdom: o.kingdom ?? null,
    class: o.class ?? null,
    family: o.family ?? null,
    date: o.eventDate ?? (o.year ? String(o.year) : null),
    latitude: o.decimalLatitude ?? null,
    longitude: o.decimalLongitude ?? null,
    uncertainty_m: o.coordinateUncertaintyInMeters ?? null,
    basis: o.basisOfRecord ?? null,
    dataset: o.datasetName ?? o.datasetKey ?? null,
    licence: o.license ?? null,
    iucn_category: o.iucnRedListCategory ?? null,
    gbif_key: o.key ?? null,
  };
}

export const definition = defineIntegration({
  id: "gbif",
  name: "GBIF",
  group: "nature",
  access: "open",
  territory: "Global",
  description: "Global species occurrence records: occurrences near a point (with per-species and per-licence counts) and scientific-name matching to the GBIF backbone taxonomy.",
  docsUrl: "https://techdocs.gbif.org/en/openapi/v1/occurrence",
  termsUrl: "https://www.gbif.org/terms",
  attribution: "Occurrence data from GBIF.org (https://www.gbif.org); each record carries its dataset's licence (CC0, CC BY or CC BY-NC) and must be cited by dataset or download DOI.",
  licence: "restricted",
  envVars: [],
  status: "built_unverified",
  notes: [
    "No key for search; large extracts should use the download API (needs a GBIF account) which issues a citable DOI.",
    "geoDistance takes latitude,longitude,distance (e.g. 51.5,-0.14,2km). Results are paged (limit up to 300; 100 here). Facets on speciesKey and license are requested for summaries.",
    "Licences vary per dataset (CC0, CC BY, CC BY-NC); CC BY-NC records cannot be used commercially without the publisher's permission.",
    "UK records on GBIF largely mirror NBN Atlas datasets but with a lag; for UK sites use NBN Atlas first and GBIF for cross-border or global sites. Absence of records is not absence of species.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "occurrence/search", { limit: 0 })),
  operations: [
    {
      id: "occurrences_near",
      label: "Occurrences near a point",
      description: "Occurrence records within a distance of a point, with per-species and per-licence counts.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
        { name: "distance_km", label: "Distance (km)", type: "number", default: 1, min: 0.1, max: 50 },
        { name: "from_year", label: "Records from year", type: "integer", default: 2016, min: 1600, max: 2100 },
        { name: "country", label: "Country (ISO 2)", type: "string", default: "GB", placeholder: "GB", help: "Leave blank to search without a country filter." },
        { name: "limit", label: "Records to return", type: "integer", default: 100, min: 0, max: 300 },
      ],
      async run(params, ctx) {
        const country = params.country ? String(params.country).toUpperCase() : undefined;
        const base = buildUrl(BASE, "occurrence/search", {
          geoDistance: `${params.latitude},${params.longitude},${params.distance_km}km`,
          hasCoordinate: true,
          hasGeospatialIssue: false,
          occurrenceStatus: "PRESENT",
          country,
          year: params.from_year ? `${params.from_year},${ctx.now().getUTCFullYear()}` : undefined,
          limit: params.limit as number,
        });
        const url = `${base}&facet=speciesKey&facet=license&facetLimit=100`;
        const { data } = await fetchJson<SearchResponse>(ctx, url, {}, { timeoutMs: 45_000 });
        const rows = (data.results ?? []).map(toRow);
        const nameByKey = new Map<string, string>();
        for (const o of data.results ?? []) if (o.taxonKey !== undefined) nameByKey.set(String(o.taxonKey), o.species ?? o.scientificName ?? String(o.taxonKey));
        const speciesFacet = (data.facets ?? []).find((f) => f.field?.toUpperCase() === "SPECIES_KEY")?.counts ?? [];
        const licenceFacet = (data.facets ?? []).find((f) => f.field?.toUpperCase() === "LICENSE")?.counts ?? [];
        const species = speciesFacet.map((c) => ({ species_key: c.name ?? null, name: nameByKey.get(c.name ?? "") ?? null, records: c.count ?? 0 }));
        const licences = licenceFacet.map((c) => `${c.name}: ${c.count}`).join(", ");
        return {
          summary: (data.count ?? 0)
            ? `${(data.count ?? 0).toLocaleString("en-GB")} occurrence records within ${params.distance_km} km${country ? ` in ${country}` : ""} since ${params.from_year ?? "any year"}, ${species.length} species (facet); showing ${rows.length}. Licences: ${licences || "n/a"}.`
            : `No GBIF occurrences within ${params.distance_km} km of ${params.latitude}, ${params.longitude}${country ? ` in ${country}` : ""} since ${params.from_year ?? "any year"}. This is not evidence of absence.`,
          columns: COLUMNS,
          rows,
          raw: { count: data.count, endOfRecords: data.endOfRecords, species, licences: licenceFacet, results: data.results },
          provenance: makeProvenance(definition, ctx, { dataset: "occurrence/search", basis: rows.length ? "measured" : "unavailable" }),
          warnings: [
            "Licence differs per record; CC BY-NC records need publisher permission for commercial use.",
            "No records is not evidence of no ecological risk; recording effort is uneven and sensitive species are generalised.",
          ],
        };
      },
    },
    {
      id: "species_match",
      label: "Match a scientific name",
      description: "Resolves a scientific name to the GBIF backbone taxonomy with confidence and classification.",
      params: [{ name: "name", label: "Scientific name", type: "string", required: true, placeholder: "Triturus cristatus" }],
      async run(params, ctx) {
        const { data } = await fetchJson<Match>(ctx, buildUrl(BASE, "species/match", { name: String(params.name), verbose: false }));
        const matched = data.matchType && data.matchType !== "NONE";
        const row = {
          matched_name: data.scientificName ?? null,
          canonical_name: data.canonicalName ?? null,
          rank: data.rank ?? null,
          status: data.status ?? null,
          match_type: data.matchType ?? null,
          confidence: data.confidence ?? null,
          kingdom: data.kingdom ?? null,
          class: data.class ?? null,
          order: data.order ?? null,
          family: data.family ?? null,
          usage_key: data.usageKey ?? null,
        };
        return {
          summary: matched ? `"${params.name}" matched ${row.matched_name} (${row.rank ?? "rank n/a"}, ${row.match_type}, confidence ${row.confidence ?? "n/a"}); ${[row.kingdom, row.class, row.order, row.family].filter(Boolean).join(" > ")}.` : `No GBIF backbone match for "${params.name}"${data.note ? ` (${data.note})` : ""}.`,
          columns: Object.keys(row),
          rows: matched ? [row] : [],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "species/match", basis: matched ? "measured" : "unavailable" }),
        };
      },
    },
  ],
});
