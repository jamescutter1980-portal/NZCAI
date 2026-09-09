import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth } from "../framework";

/**
 * DfT Road Traffic Statistics API (roadtraffic.dft.gov.uk/api), a JSON:API
 * style service with filter[...] and page[...] query parameters.
 *
 * Built from the API documentation as summarised by open-source clients
 * (filter[local_authority_id], page[size]/page[number], data[] + links.next
 * response envelope); no live call has been made from this codebase. No
 * latitude/longitude filter is documented, so "near a point" is a
 * client-side distance filter over a local authority's count points.
 */

export const BASE = "https://roadtraffic.dft.gov.uk/api";

interface Envelope<T> {
  data?: T[];
  links?: { next?: string | null; last?: string | null };
  meta?: { total?: number; current_page?: number; last_page?: number };
}
interface CountPoint {
  id?: number;
  count_point_id?: number;
  latitude?: number | string;
  longitude?: number | string;
  easting?: number;
  northing?: number;
  road_name?: string;
  road_category?: string;
  road_type?: string;
  start_junction_road_name?: string;
  end_junction_road_name?: string;
  link_length_km?: number | string;
  local_authority_id?: number;
  local_authority_name?: string;
  region_id?: number;
  aadf_year?: number;
  year?: number;
}
interface Aadf {
  count_point_id?: number;
  year?: number;
  estimation_method?: string;
  estimation_method_detailed?: string;
  pedal_cycles?: number;
  two_wheeled_motor_vehicles?: number;
  cars_and_taxis?: number;
  buses_and_coaches?: number;
  lgvs?: number;
  all_hgvs?: number;
  all_motor_vehicles?: number;
  road_name?: string;
  latitude?: number | string;
  longitude?: number | string;
  local_authority_name?: string;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

const CP_COLUMNS = ["count_point_id", "distance_km", "road_name", "road_category", "road_type", "from_junction", "to_junction", "link_length_km", "latitude", "longitude", "local_authority_id", "latest_aadf_year"];

export const definition = defineIntegration({
  id: "dft-road-traffic",
  name: "DfT road traffic statistics",
  group: "transport",
  access: "open",
  territory: "GB",
  description: "Department for Transport traffic count points and annual average daily flow (AADF) by vehicle type, for local road traffic context around a site (freight and car exposure, active-travel baselines).",
  docsUrl: "https://roadtraffic.dft.gov.uk/api-documentation",
  termsUrl: "https://roadtraffic.dft.gov.uk/downloads",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Department for Transport, Road Traffic Statistics.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "Unauthenticated; the API paginates with page[number] and page[size] and returns a data[] envelope with links.next. No latitude/longitude filter is documented, so nearby points are found by fetching a local authority's count points (up to 5 pages of 100) and filtering by distance here.",
    "DfT local authority ids are the API's own integers (e.g. from /api/local-authorities), not ONS codes; they are not hard-coded here.",
    "AADF is an estimate (Counted, Grown, ATC, Dependent or Derived; see estimation_method). Every major-road link has a count point, but minor roads are a rotating sample, so no nearby count point is not evidence of low traffic. Do not add AADFs from different count points together.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "count-points", { "page[size]": 1 })),
  operations: [
    {
      id: "count_points",
      label: "Count points in a local authority (optionally nearest a point)",
      description: "Traffic count point locations for a DfT local authority id, sorted by distance from an optional latitude/longitude.",
      params: [
        { name: "local_authority_id", label: "DfT local authority id", type: "integer", required: true, min: 1, placeholder: "71" },
        { name: "latitude", label: "Latitude (optional)", type: "latitude", placeholder: "51.501" },
        { name: "longitude", label: "Longitude (optional)", type: "longitude", placeholder: "-0.142" },
        { name: "radius_km", label: "Radius (km)", type: "number", default: 2, min: 0.1, max: 50 },
        { name: "max_pages", label: "Pages to fetch (100 points each)", type: "integer", default: 3, min: 1, max: 5 },
      ],
      async run(params, ctx) {
        const hasPoint = params.latitude !== undefined && params.longitude !== undefined;
        const lat = Number(params.latitude);
        const lon = Number(params.longitude);
        const points: CountPoint[] = [];
        let url: string | null = buildUrl(BASE, "count-points", { "filter[local_authority_id]": params.local_authority_id as number, "page[size]": 100, "page[number]": 1 });
        let pages = 0;
        while (url && pages < (params.max_pages as number)) {
          const { data }: { data: Envelope<CountPoint> } = await fetchJson<Envelope<CountPoint>>(ctx, url);
          points.push(...(data.data ?? []));
          pages++;
          url = data.links?.next ?? null;
        }
        let rows = points.map((p) => {
          const plat = Number(p.latitude);
          const plon = Number(p.longitude);
          const distance = hasPoint && Number.isFinite(plat) && Number.isFinite(plon) ? Math.round(haversineKm(lat, lon, plat, plon) * 100) / 100 : null;
          return {
            count_point_id: p.count_point_id ?? p.id ?? null,
            distance_km: distance,
            road_name: p.road_name ?? null,
            road_category: p.road_category ?? null,
            road_type: p.road_type ?? null,
            from_junction: p.start_junction_road_name ?? null,
            to_junction: p.end_junction_road_name ?? null,
            link_length_km: p.link_length_km ?? null,
            latitude: Number.isFinite(plat) ? plat : null,
            longitude: Number.isFinite(plon) ? plon : null,
            local_authority_id: p.local_authority_id ?? null,
            latest_aadf_year: p.aadf_year ?? p.year ?? null,
          };
        });
        if (hasPoint) {
          rows = rows.filter((r) => r.distance_km !== null && r.distance_km <= (params.radius_km as number)).sort((a, b) => (a.distance_km ?? 0) - (b.distance_km ?? 0));
        }
        rows = rows.slice(0, 100);
        return {
          summary: hasPoint
            ? `${rows.length} count points within ${params.radius_km} km of ${lat}, ${lon} (from ${points.length} points in local authority ${params.local_authority_id}, ${pages} page(s)).${url ? " More pages exist." : ""}`
            : `${points.length} count points in local authority ${params.local_authority_id} (${pages} page(s)); showing ${rows.length}.${url ? " More pages exist." : ""}`,
          columns: CP_COLUMNS,
          rows,
          raw: { fetched: points.length, pages, next: url },
          provenance: makeProvenance(definition, ctx, { dataset: "count-points", basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["Minor roads are sampled, so an absent count point is not evidence of low traffic."],
        };
      },
    },
    {
      id: "aadf",
      label: "Annual average daily flow for a count point",
      description: "AADF by vehicle class for one count point, optionally for one year; latest year first.",
      params: [
        { name: "count_point_id", label: "Count point id", type: "integer", required: true, min: 1, placeholder: "6023" },
        { name: "year", label: "Year (optional)", type: "integer", min: 2000, max: 2100 },
      ],
      async run(params, ctx) {
        const url = buildUrl(BASE, "average-annual-daily-flow", { "filter[count_point_id]": params.count_point_id as number, "filter[year]": params.year as number | undefined, "page[size]": 100 });
        const { data } = await fetchJson<Envelope<Aadf>>(ctx, url);
        const rows = (data.data ?? [])
          .map((a) => ({
            year: a.year ?? null,
            all_motor_vehicles: a.all_motor_vehicles ?? null,
            cars_and_taxis: a.cars_and_taxis ?? null,
            lgvs: a.lgvs ?? null,
            all_hgvs: a.all_hgvs ?? null,
            buses_and_coaches: a.buses_and_coaches ?? null,
            two_wheeled_motor_vehicles: a.two_wheeled_motor_vehicles ?? null,
            pedal_cycles: a.pedal_cycles ?? null,
            estimation_method: a.estimation_method ?? null,
            estimation_method_detailed: a.estimation_method_detailed ?? null,
            road_name: a.road_name ?? null,
          }))
          .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
        const latest = rows[0];
        return {
          summary: latest
            ? `Count point ${params.count_point_id}${latest.road_name ? ` (${latest.road_name})` : ""}: ${latest.all_motor_vehicles?.toLocaleString("en-GB") ?? "n/a"} motor vehicles/day in ${latest.year} (${latest.estimation_method ?? "method n/a"}), of which ${latest.all_hgvs?.toLocaleString("en-GB") ?? "n/a"} HGVs. ${rows.length} year(s) on record.`
            : `No AADF records for count point ${params.count_point_id}${params.year ? ` in ${params.year}` : ""}.`,
          columns: ["year", "all_motor_vehicles", "cars_and_taxis", "lgvs", "all_hgvs", "buses_and_coaches", "two_wheeled_motor_vehicles", "pedal_cycles", "estimation_method", "estimation_method_detailed", "road_name"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "average-annual-daily-flow", basis: rows.length ? (latest?.estimation_method?.toLowerCase() === "counted" ? "measured" : "estimated") : "unavailable" }),
          warnings: ["AADF is an annual average estimated from a count (Counted) or grown from earlier years (Estimated); check estimation_method before relying on a single link."],
        };
      },
    },
  ],
});
