import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationContext } from "../framework";

const BASE = "https://api.postcodes.io";

interface PostcodeResult {
  postcode: string;
  longitude: number | null;
  latitude: number | null;
  eastings: number | null;
  northings: number | null;
  country: string;
  region: string | null;
  admin_district: string | null;
  admin_ward: string | null;
  parliamentary_constituency: string | null;
  lsoa: string | null;
  msoa: string | null;
  codes: { admin_district: string; lsoa: string; msoa: string; ward: string; parliamentary_constituency: string };
}

const COLUMNS = ["postcode", "latitude", "longitude", "eastings", "northings", "country", "region", "admin_district", "admin_ward", "lsoa", "msoa", "parliamentary_constituency"];

function toRow(r: PostcodeResult) {
  return {
    postcode: r.postcode,
    latitude: r.latitude,
    longitude: r.longitude,
    eastings: r.eastings,
    northings: r.northings,
    country: r.country,
    region: r.region,
    admin_district: r.admin_district,
    admin_ward: r.admin_ward,
    lsoa: r.lsoa,
    msoa: r.msoa,
    parliamentary_constituency: r.parliamentary_constituency,
    lsoa_code: r.codes?.lsoa,
    district_code: r.codes?.admin_district,
  };
}

export const definition = defineIntegration({
  id: "postcodes-io",
  name: "postcodes.io",
  group: "identity",
  access: "open",
  territory: "UK",
  description: "Free postcode lookup and reverse geocoding built on ONS Postcode Directory and OS Open Names. Gives coordinates, LSOA, MSOA, district, ward and constituency for a postcode.",
  docsUrl: "https://postcodes.io/docs",
  attribution: "Contains OS data © Crown copyright and database right; contains Royal Mail data © Royal Mail copyright and database right; contains National Statistics data © Crown copyright and database right. Served by postcodes.io.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "No key, no documented hard rate limit; be considerate and cache.",
    "Postcode centroids are not building footprints. Use OS OpenUPRN or OS Places for building-level positions.",
  ],
  healthCheck: simpleHealth(`${BASE}/postcodes/SW1A1AA`),
  operations: [
    {
      id: "lookup",
      label: "Look up a postcode",
      description: "Coordinates and statistical geographies for one postcode.",
      params: [{ name: "postcode", label: "Postcode", type: "postcode", required: true, placeholder: "SW1A 1AA" }],
      async run(params, ctx: OperationContext) {
        const { data } = await fetchJson<{ status: number; result: PostcodeResult | null }>(ctx, buildUrl(BASE, `postcodes/${encodeURIComponent(String(params.postcode))}`), {}, { acceptStatuses: [404] });
        if (!data.result) {
          return { summary: `Postcode ${params.postcode} not found.`, rows: [], columns: COLUMNS, raw: data, provenance: makeProvenance(definition, ctx, { dataset: "postcodes", basis: "unavailable" }) };
        }
        const row = toRow(data.result);
        return {
          summary: `${data.result.postcode}: ${data.result.admin_district ?? "unknown district"}, ${data.result.region ?? data.result.country}. LSOA ${data.result.lsoa ?? "n/a"}.`,
          columns: COLUMNS,
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "postcodes", basis: "measured" }),
        };
      },
    },
    {
      id: "reverse",
      label: "Nearest postcodes to a point",
      description: "Postcodes within a radius of a latitude and longitude.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
        { name: "radius", label: "Radius (m)", type: "integer", default: 200, min: 1, max: 2000 },
      ],
      async run(params, ctx) {
        const url = buildUrl(BASE, "postcodes", { lat: params.latitude as number, lon: params.longitude as number, radius: params.radius as number, limit: 10 });
        const { data } = await fetchJson<{ status: number; result: (PostcodeResult & { distance: number })[] | null }>(ctx, url);
        const rows = (data.result ?? []).map((r) => ({ distance_m: Math.round(r.distance), ...toRow(r) }));
        return {
          summary: `${rows.length} postcodes within ${params.radius} m.`,
          columns: ["distance_m", ...COLUMNS],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "postcodes", basis: "measured" }),
        };
      },
    },
    {
      id: "bulk",
      label: "Look up several postcodes",
      description: "Up to 100 postcodes, one per line.",
      params: [{ name: "postcodes", label: "Postcodes", type: "text", required: true, placeholder: "SW1A 1AA\nM1 1AE" }],
      async run(params, ctx) {
        const list = String(params.postcodes).split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 100);
        const { data } = await fetchJson<{ status: number; result: { query: string; result: PostcodeResult | null }[] }>(ctx, `${BASE}/postcodes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ postcodes: list }),
        });
        const rows = data.result.map((r) => (r.result ? toRow(r.result) : { postcode: r.query, country: "not found" }));
        const found = data.result.filter((r) => r.result).length;
        return {
          summary: `${found} of ${list.length} postcodes found.`,
          columns: COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "postcodes", basis: "measured" }),
        };
      },
    },
  ],
});
