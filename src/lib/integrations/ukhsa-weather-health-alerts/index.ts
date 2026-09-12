import { defineIntegration, fetchJson, makeProvenance, simpleHealth } from "../framework";

/**
 * UKHSA Weather-Health Alerting System (heat-health and cold-health alerts) via the
 * UKHSA data dashboard public API.
 *
 * URL structure, theme/sub-theme/topic names, timeseries fields and the matrix-number
 * to colour mapping come from the UKHSA's own open-source API repository
 * (github.com/UKHSA-Internal/data-dashboard-api: public_api/urls.py,
 * validation/enums/theme_and_topic_enums.py, metrics/domain/weather_health_alerts/mapping.py,
 * public_api/version_02/serializers/timeseries_serializers.py) and from two open-source
 * consumers of the heat-alert metric. Not exercised live from this environment.
 */

const BASE = "https://api.ukhsa-dashboard.data.gov.uk";
const THEME = "extreme_event";
const SUB_THEME = "weather_alert";
const GEOGRAPHY_TYPE = "Government Office Region";

export const REGIONS: { value: string; label: string; code: string }[] = [
  { value: "North East", label: "North East", code: "E12000001" },
  { value: "North West", label: "North West", code: "E12000002" },
  { value: "Yorkshire and The Humber", label: "Yorkshire and The Humber", code: "E12000003" },
  { value: "East Midlands", label: "East Midlands", code: "E12000004" },
  { value: "West Midlands", label: "West Midlands", code: "E12000005" },
  { value: "East of England", label: "East of England", code: "E12000006" },
  { value: "London", label: "London", code: "E12000007" },
  { value: "South East", label: "South East", code: "E12000008" },
  { value: "South West", label: "South West", code: "E12000009" },
];

interface TimeseriesRecord {
  theme: string;
  sub_theme: string;
  topic: string;
  geography_type: string;
  geography: string;
  geography_code?: string;
  metric: string;
  metric_group?: string;
  stratum?: string;
  sex?: string;
  age?: string;
  year?: number;
  month?: number;
  epiweek?: number;
  date: string;
  metric_value: number;
  in_reporting_delay_period?: boolean;
}

interface Page {
  count: number;
  next: string | null;
  previous: string | null;
  results: TimeseriesRecord[];
}

/** UKHSA risk-matrix number (1-16) to alert colour, per the dashboard source. */
export function colourForMatrix(n: number): "Green" | "Yellow" | "Amber" | "Red" {
  if (n <= 6) return "Green";
  if (n <= 11) return "Yellow";
  if (n <= 15) return "Amber";
  return "Red";
}

const IMPACT: Record<number, string> = { 1: "Very low", 2: "Very low", 3: "Very low", 4: "Very low", 5: "Low", 6: "Low", 7: "Low", 8: "Low", 9: "Medium", 10: "Medium", 12: "Medium", 13: "Medium", 11: "High", 14: "High", 15: "High", 16: "High" };
const LIKELIHOOD: Record<number, string> = { 1: "Very low", 5: "Very low", 9: "Very low", 11: "Very low", 2: "Low", 6: "Low", 10: "Low", 14: "Low", 3: "Medium", 7: "Medium", 12: "Medium", 15: "Medium", 4: "High", 8: "High", 13: "High", 16: "High" };

export function metricUrl(alertType: "heat" | "cold", region: string, pageSize: number): string {
  const topic = alertType === "heat" ? "Heat-alert" : "Cold-alert";
  const metric = `${alertType}-alert_headline_matrixNumber`;
  const path = ["themes", THEME, "sub_themes", SUB_THEME, "topics", topic, "geography_types", GEOGRAPHY_TYPE, "geographies", region, "metrics", metric].map(encodeURIComponent).join("/");
  return `${BASE}/${path}?page_size=${pageSize}`;
}

export const definition = defineIntegration({
  id: "ukhsa-weather-health-alerts",
  name: "UKHSA Weather-Health Alerts",
  group: "weather",
  access: "open",
  territory: "England",
  description: "Heat-health and cold-health alert levels (green, yellow, amber, red) by English region from the UKHSA and Met Office Weather-Health Alerting System, via the UKHSA data dashboard API.",
  docsUrl: "https://ukhsa-dashboard.data.gov.uk/access-our-data",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: UK Health Security Agency data dashboard (Weather-Health Alerting System with the Met Office).",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "Alerts cover England only, by the nine Government Office Regions. The heat season runs 1 June to 30 September and the cold season 1 November to 31 March; outside the season the metric may not update.",
    "The API publishes a risk-matrix number (1-16); the dashboard maps 1-6 Green, 7-11 Yellow, 12-15 Amber, 16 Red, with impact and likelihood levels derived from the matrix position (mapping reproduced from the UKHSA source code).",
    "URL path (themes/extreme_event/sub_themes/weather_alert/topics/Heat-alert/geography_types/Government Office Region/geographies/<region>/metrics/heat-alert_headline_matrixNumber) is built from the UKHSA API source code; two community clients used older theme names, so if the live call returns 404 check the theme and sub-theme via the API's hyperlinked navigation from https://api.ukhsa-dashboard.data.gov.uk/themes/.",
    "An alert level is a public-health signal, not a building metric: outdoor temperature alone does not establish overheating risk for a specific building.",
    "No key; the API is rate limited (unpublished) and paginates at page_size up to 365. Not exercised live from this environment.",
  ],
  healthCheck: simpleHealth(`${BASE}/themes/`),
  operations: [
    {
      id: "current-alert",
      label: "Current heat or cold alert for a region",
      description: "Latest alert level and recent history for one English region.",
      params: [
        { name: "alert_type", label: "Alert type", type: "select", default: "heat", options: [{ value: "heat", label: "Heat-health alert" }, { value: "cold", label: "Cold-health alert" }] },
        { name: "region", label: "Region", type: "select", required: true, options: REGIONS.map(({ value, label }) => ({ value, label })) },
        { name: "days", label: "History (records)", type: "integer", default: 14, min: 1, max: 100 },
      ],
      async run(params, ctx) {
        const alertType = (params.alert_type as "heat" | "cold" | undefined) ?? "heat";
        const region = String(params.region);
        const url = metricUrl(alertType, region, Number(params.days ?? 14));
        const { data, status } = await fetchJson<Page>(ctx, url, {}, { acceptStatuses: [404] });
        const columns = ["date", "matrix_number", "colour", "impact", "likelihood", "region", "region_code"];
        const results = status === 404 ? [] : (data.results ?? []);
        if (!results.length) {
          return {
            summary: status === 404 ? `The UKHSA API returned 404 for ${alertType} alerts in ${region}; the metric path may have changed.` : `No ${alertType}-health alert records published for ${region}.`,
            columns,
            rows: [],
            raw: data,
            provenance: makeProvenance(definition, ctx, { dataset: `${alertType}-alert_headline_matrixNumber`, basis: "unavailable" }),
            warnings: ["No records usually means no alert is in force or the alerting season is closed, not that the region is at risk."],
          };
        }
        const rows = results
          .map((rec) => ({
            date: rec.date,
            matrix_number: rec.metric_value,
            colour: colourForMatrix(rec.metric_value),
            impact: IMPACT[rec.metric_value] ?? null,
            likelihood: LIKELIHOOD[rec.metric_value] ?? null,
            region: rec.geography,
            region_code: rec.geography_code ?? REGIONS.find((r) => r.value === rec.geography)?.code ?? null,
          }))
          .sort((a, b) => b.date.localeCompare(a.date));
        const latest = rows[0];
        return {
          summary: `${latest.colour.toUpperCase()} ${alertType}-health alert level for ${region} on ${latest.date} (matrix ${latest.matrix_number}: impact ${latest.impact ?? "n/a"}, likelihood ${latest.likelihood ?? "n/a"}). ${rows.length} record(s) returned.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: `${alertType}-alert_headline_matrixNumber`, basis: "client_declared" }),
          warnings: [
            "Alert levels are UKHSA/Met Office public-health assessments of forecast weather, not measurements at the building.",
            "Green means no alert; it does not mean a building will not overheat or that heating demand is low.",
          ],
          links: [{ label: "UKHSA dashboard: weather-health alerts", url: "https://ukhsa-dashboard.data.gov.uk/weather-health-alerts" }],
        };
      },
    },
  ],
});
